from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http import cookies
from pathlib import Path
from urllib.parse import urlparse
import base64
import hashlib
import hmac
import json
import os
import time


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
PATIENTS_FILE = DATA_DIR / "patients.json"
DATABASE_URL = os.environ.get("DATABASE_URL", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET") or ADMIN_PASSWORD or "virtus-local-dev"
SESSION_MAX_AGE = 60 * 60 * 12


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
            self.send_json(public_patient(patient))
            return

        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/login":
            payload = self.read_json_body()
            if payload is None:
                return

            if not login_required() or payload.get("password") == ADMIN_PASSWORD:
                self.send_login_success()
                return

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
            patient = self.read_json_body()
            if patient is None:
                return
            if not isinstance(patient, dict):
                self.send_error_json(400, "Paciente inválido")
                return

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

        self.send_error_json(404, "Rota não encontrada")

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != "/api/patients":
            self.send_error_json(404, "Rota não encontrada")
            return

        if not self.require_auth():
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

    def is_authenticated(self):
        if not login_required():
            return True

        cookie_header = self.headers.get("Cookie", "")
        request_cookies = cookies.SimpleCookie(cookie_header)
        session = request_cookies.get("virtus_session")
        return bool(session and verify_session_token(session.value))

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
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def login_required():
    return bool(ADMIN_PASSWORD)


def create_session_token():
    expires = str(int(time.time()) + SESSION_MAX_AGE)
    payload = f"admin:{expires}"
    signature = sign(payload)
    return base64.urlsafe_b64encode(f"{payload}:{signature}".encode("utf-8")).decode("utf-8")


def verify_session_token(token):
    try:
        decoded = base64.urlsafe_b64decode(token.encode("utf-8")).decode("utf-8")
        user, expires, signature = decoded.split(":", 2)
    except ValueError:
        return False

    payload = f"{user}:{expires}"
    if not hmac.compare_digest(signature, sign(payload)):
        return False

    return user == "admin" and int(expires) > int(time.time())


def sign(payload):
    return hmac.new(SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def session_cookie(token):
    return f"virtus_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_MAX_AGE}; Secure"


def expired_session_cookie():
    return "virtus_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure"


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
    ensure_database()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "4176"))
    server = ThreadingHTTPServer((host, port), VirtusHandler)
    print(f"Virtus Acompanha em http://{host}:{port}")
    server.serve_forever()
