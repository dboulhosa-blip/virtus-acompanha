from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http import cookies
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
PATIENTS_FILE = DATA_DIR / "patients.json"
DATABASE_URL = os.environ.get("DATABASE_URL", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
IS_PRODUCTION = bool(
    os.environ.get("RENDER") or
    os.environ.get("RENDER_SERVICE_ID") or
    os.environ.get("HOST") == "0.0.0.0"
)
SESSION_SECRET = os.environ.get("SESSION_SECRET") or (
    secrets.token_urlsafe(32) if not IS_PRODUCTION else ""
)
SESSION_MAX_AGE = 60 * 60 * 12
MAX_BODY_BYTES = 64 * 1024
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCK_SECONDS = 15 * 60
MAX_LOGIN_ATTEMPTS = 5
LOGIN_ATTEMPTS = {}
PATIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


class VirtusHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/session":
            self.send_json({"authenticated": self.is_authenticated(), "loginRequired": login_required()})
            return

        if path == "/api/patients":
            if not self.require_auth():
                return
            self.send_json(read_patients())
            return

        if path.startswith("/api/patients/"):
            patient_id = path.removeprefix("/api/patients/")
            patient = find_patient(patient_id)
            if not patient:
                self.send_error_json(404, "Paciente não encontrado")
                return
            if not self.valid_patient_access(patient):
                self.send_error_json(403, "Link inválido")
                return
            self.send_json(public_patient(patient))
            return

        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/login":
            payload = self.read_json_body()
            if payload is None:
                return

            if is_login_blocked(self.client_ip()):
                self.send_error_json(429, "Muitas tentativas. Aguarde alguns minutos.")
                return

            if not login_required() or payload.get("password") == ADMIN_PASSWORD:
                clear_login_attempts(self.client_ip())
                self.send_login_success()
                return

            register_login_failure(self.client_ip())
            self.send_error_json(401, "Senha inválida")
            return

        if path == "/api/logout":
            self.send_response(204)
            self.send_header("Set-Cookie", expired_session_cookie())
            self.end_headers()
            return

        if path == "/api/patients":
            if not self.require_auth():
                return
            if not self.require_same_origin():
                return
            patient = self.read_json_body()
            if patient is None:
                return
            if not isinstance(patient, dict):
                self.send_error_json(400, "Paciente inválido")
                return

            patient = prepare_registered_patient(patient)
            patients = read_patients()
            patients.insert(0, patient)
            write_patients(patients)
            self.send_json(patient)
            return

        if path.startswith("/api/patients/") and path.endswith("/response"):
            patient_id = path.removeprefix("/api/patients/").removesuffix("/response")
            payload = self.read_json_body()
            if payload is None:
                return

            patients = read_patients()
            patient = next((item for item in patients if item.get("id") == patient_id), None)
            if not patient:
                self.send_error_json(404, "Paciente não encontrado")
                return
            if not self.valid_patient_access(patient):
                self.send_error_json(403, "Link inválido")
                return
            if patient.get("status") == "Formulário respondido":
                self.send_json(public_patient(patient))
                return

            updated_patient = apply_response(patient, payload)
            write_patients([
                updated_patient if item.get("id") == patient_id else item for item in patients
            ])
            self.send_json(public_patient(updated_patient))
            return

        self.send_error_json(404, "Rota não encontrada")

    def do_PATCH(self):
        path = urlparse(self.path).path

        if path.startswith("/api/patients/") and path.endswith("/decision"):
            if not self.require_auth():
                return
            if not self.require_same_origin():
                return

            patient_id = path.removeprefix("/api/patients/").removesuffix("/decision")
            payload = self.read_json_body()
            if payload is None:
                return

            decision = str(payload.get("decision", "")).strip()
            if not decision:
                self.send_error_json(400, "Decisão obrigatória")
                return

            patients = read_patients()
            updated_patient = None
            next_patients = []
            for patient in patients:
                if patient.get("id") == patient_id:
                    updated_patient = {
                        **patient,
                        "decision": decision,
                        "status": "Decisão médica registrada",
                        "action": f"{decision} definido pelo médico",
                    }
                    next_patients.append(updated_patient)
                else:
                    next_patients.append(patient)

            if not updated_patient:
                self.send_error_json(404, "Paciente não encontrado")
                return

            write_patients(next_patients)
            self.send_json(updated_patient)
            return

        if path.startswith("/api/patients/") and path.endswith("/sent"):
            if not self.require_auth():
                return
            if not self.require_same_origin():
                return

            patient_id = path.removeprefix("/api/patients/").removesuffix("/sent")
            patients = read_patients()
            updated_patient = None
            next_patients = []
            for patient in patients:
                if patient.get("id") == patient_id:
                    updated_patient = {
                        **patient,
                        "status": "WhatsApp enviado",
                        "action": "Aguardando resposta do formulário",
                    }
                    next_patients.append(updated_patient)
                else:
                    next_patients.append(patient)

            if not updated_patient:
                self.send_error_json(404, "Paciente não encontrado")
                return

            write_patients(next_patients)
            self.send_json(updated_patient)
            return

        self.send_error_json(404, "Rota não encontrada")

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != "/api/patients":
            self.send_error_json(404, "Rota não encontrada")
            return

        if not self.require_auth():
            return
        if not self.require_same_origin():
            return

        patients = self.read_json_body()
        if patients is None:
            return
        if not isinstance(patients, list):
            self.send_error_json(400, "A lista de pacientes é obrigatória")
            return

        write_patients(patients)
        self.send_json({"ok": True})

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            self.send_error_json(413, "Requisição muito grande")
            return None

        payload = self.rfile.read(length)

        try:
            return json.loads(payload.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_error_json(400, "JSON inválido")
            return None

    def require_auth(self):
        if self.is_authenticated():
            return True

        self.send_error_json(401, "Login obrigatório")
        return False

    def require_same_origin(self):
        origin = self.headers.get("Origin") or self.headers.get("Referer")
        if not origin:
            return True

        request_host = self.headers.get("Host", "")
        origin_host = urlparse(origin).netloc
        if origin_host == request_host:
            return True

        self.send_error_json(403, "Origem não autorizada")
        return False

    def is_authenticated(self):
        if not login_required():
            return True

        cookie_header = self.headers.get("Cookie", "")
        request_cookies = cookies.SimpleCookie(cookie_header)
        session = request_cookies.get("virtus_session")
        return bool(session and verify_session_token(session.value))

    def client_ip(self):
        forwarded_for = self.headers.get("X-Forwarded-For", "")
        return (forwarded_for.split(",")[0].strip() or self.client_address[0])

    def valid_patient_access(self, patient):
        expected_token = patient.get("formToken")
        request_token = self.query_params().get("token", "")
        if not expected_token:
            return True
        return hmac.compare_digest(str(expected_token), str(request_token))

    def query_params(self):
        parsed = urlparse(self.path)
        return {key: values[0] for key, values in parse_qs(parsed.query).items()}

    def send_login_success(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if login_required():
            self.send_header("Set-Cookie", session_cookie(create_session_token()))
        body = json.dumps({"authenticated": True}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_security_headers()
        super().end_headers()

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )


def login_required():
    return True if IS_PRODUCTION else bool(ADMIN_PASSWORD)


def validate_security_configuration():
    errors = []

    if IS_PRODUCTION and not ADMIN_PASSWORD:
        errors.append("ADMIN_PASSWORD é obrigatório em produção")
    if IS_PRODUCTION and len(SESSION_SECRET) < 32:
        errors.append("SESSION_SECRET deve ter pelo menos 32 caracteres em produção")
    if IS_PRODUCTION and not DATABASE_URL:
        errors.append("DATABASE_URL é obrigatório em produção")

    if errors:
        for error in errors:
            print(f"Erro de configuração de segurança: {error}")
        raise SystemExit(1)


def register_login_failure(client_ip):
    now = time.time()
    attempts = [
        attempt for attempt in LOGIN_ATTEMPTS.get(client_ip, {}).get("attempts", [])
        if now - attempt < LOGIN_WINDOW_SECONDS
    ]
    attempts.append(now)
    LOGIN_ATTEMPTS[client_ip] = {"attempts": attempts}

    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        LOGIN_ATTEMPTS[client_ip]["locked_until"] = now + LOGIN_LOCK_SECONDS


def is_login_blocked(client_ip):
    record = LOGIN_ATTEMPTS.get(client_ip)
    if not record:
        return False

    locked_until = record.get("locked_until", 0)
    if locked_until and locked_until > time.time():
        return True

    if locked_until:
        clear_login_attempts(client_ip)
    return False


def clear_login_attempts(client_ip):
    LOGIN_ATTEMPTS.pop(client_ip, None)


def create_session_token():
    expires = str(int(time.time()) + SESSION_MAX_AGE)
    payload = f"admin:{expires}"
    signature = sign(payload)
    return base64.urlsafe_b64encode(f"{payload}:{signature}".encode("utf-8")).decode("utf-8")


def verify_session_token(token):
    try:
        decoded = base64.urlsafe_b64decode(token.encode("utf-8")).decode("utf-8")
        user, expires, signature = decoded.split(":", 2)
        is_active = int(expires) > int(time.time())
    except (ValueError, TypeError):
        return False

    payload = f"{user}:{expires}"
    if not hmac.compare_digest(signature, sign(payload)):
        return False

    return user == "admin" and is_active


def sign(payload):
    return hmac.new(SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def session_cookie(token):
    return f"virtus_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_MAX_AGE}; Secure"


def expired_session_cookie():
    return "virtus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure"


def clean_text(value, max_length):
    return str(value or "").strip()[:max_length]


def prepare_registered_patient(patient):
    patient_id = clean_text(patient.get("id"), 80)
    if not PATIENT_ID_PATTERN.match(patient_id):
        patient_id = f"patient-{secrets.token_urlsafe(12)}"

    return {
        **patient,
        "id": patient_id,
        "name": clean_text(patient.get("name"), 120),
        "phone": re.sub(r"\D", "", str(patient.get("phone", "")))[:16],
        "birthdate": clean_text(patient.get("birthdate"), 10),
        "doctor": clean_text(patient.get("doctor"), 120),
        "lastVisit": clean_text(patient.get("lastVisit"), 10),
        "returnDate": clean_text(patient.get("returnDate"), 10),
        "status": "WhatsApp pendente",
        "classification": "Pendente",
        "action": "Enviar formulário de acompanhamento pelo WhatsApp",
        "summary": "Paciente cadastrado e aguardando resposta do formulário de acompanhamento.",
        "notes": "",
        "decision": "",
        "formToken": patient.get("formToken") or secrets.token_urlsafe(24),
    }


def public_patient(patient):
    allowed_keys = {
        "id",
        "name",
        "birthdate",
        "status",
        "classification",
        "returnDate",
        "lastVisit",
    }
    return {key: value for key, value in patient.items() if key in allowed_keys}


def classify_response(data):
    score = 0

    if data.get("improvement") in ["Muito pior", "Pior"]:
        score += 3
    if data.get("improvement") == "Sem mudanças":
        score += 1
    if data.get("adherence") == "Parcialmente":
        score += 1
    if data.get("adherence") == "Não":
        score += 3
    if data.get("sideEffects") == "Sim":
        score += 2
    if data.get("sleep") in ["Muito ruim", "Ruim"]:
        score += 2
    if data.get("sleep") == "Regular":
        score += 1
    if data.get("symptoms") in ["Muito piores", "Piores"]:
        score += 3
    if data.get("symptoms") == "Sem mudanças":
        score += 1

    if score >= 5:
        return "Vermelho"
    if score >= 2:
        return "Amarelo"
    return "Verde"


def action_for_classification(classification):
    return {
        "Verde": "Avaliar possibilidade de postergar o retorno",
        "Amarelo": "Manter retorno previamente agendado",
        "Vermelho": "Destacar para avaliação médica prioritária",
    }.get(classification, "Revisar acompanhamento")


def build_summary(data):
    side_effect_text = (
        f"efeito colateral informado: {data.get('sideEffectDetail') or 'sem detalhe'}"
        if data.get("sideEffects") == "Sim"
        else "sem efeitos colaterais importantes"
    )
    notes = str(data.get("notes", "")).strip()
    notes_text = f" Informação adicional: {notes}." if notes else ""

    return (
        f'Paciente relata evolução "{data.get("improvement")}", '
        f'adesão "{data.get("adherence")}", sono "{data.get("sleep")}", '
        f'sintomas "{data.get("symptoms")}" e {side_effect_text}.{notes_text}'
    )


def apply_response(patient, data):
    classification = classify_response(data)
    return {
        **patient,
        "name": str(data.get("name", patient.get("name", ""))).strip(),
        "birthdate": data.get("birthdate", patient.get("birthdate", "")),
        "status": "Formulário respondido",
        "classification": classification,
        "action": action_for_classification(classification),
        "summary": build_summary(data),
        "notes": str(data.get("notes", "")).strip(),
        "decision": "",
    }


def read_patients():
    if DATABASE_URL:
        return read_patients_from_database()

    if not PATIENTS_FILE.exists():
        return []

    with PATIENTS_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_patients(patients):
    if DATABASE_URL:
        write_patients_to_database(patients)
        return

    DATA_DIR.mkdir(exist_ok=True)
    with PATIENTS_FILE.open("w", encoding="utf-8") as file:
        json.dump(patients, file, ensure_ascii=False, indent=2)


def find_patient(patient_id):
    return next((patient for patient in read_patients() if patient.get("id") == patient_id), None)


def db_connect():
    import psycopg

    return psycopg.connect(DATABASE_URL)


def ensure_database():
    if not DATABASE_URL:
        return

    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS virtus_state (
                  id TEXT PRIMARY KEY,
                  payload JSONB NOT NULL
                )
                """
            )


def read_patients_from_database():
    ensure_database()
    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT payload FROM virtus_state WHERE id = 'patients'")
            row = cursor.fetchone()
            if not row:
                return []
            payload = row[0]
            if isinstance(payload, str):
                return json.loads(payload)
            return payload


def write_patients_to_database(patients):
    ensure_database()
    with db_connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO virtus_state (id, payload)
                VALUES ('patients', %s::jsonb)
                ON CONFLICT (id)
                DO UPDATE SET payload = EXCLUDED.payload
                """,
                (json.dumps(patients, ensure_ascii=False),),
            )


if __name__ == "__main__":
    validate_security_configuration()
    ensure_database()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "4176"))
    server = ThreadingHTTPServer((host, port), VirtusHandler)
    print(f"Virtus Acompanha em http://{host}:{port}")
    server.serve_forever()
