from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
PATIENTS_FILE = DATA_DIR / "patients.json"


class VirtusHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/patients":
            self.send_json(read_patients())
            return

        super().do_GET()

    def do_PUT(self):
        if self.path != "/api/patients":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)

        try:
            patients = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "JSON inválido")
            return

        if not isinstance(patients, list):
            self.send_error(400, "A lista de pacientes é obrigatória")
            return

        write_patients(patients)
        self.send_json({"ok": True})

    def send_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def read_patients():
    if not PATIENTS_FILE.exists():
        return []

    with PATIENTS_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_patients(patients):
    DATA_DIR.mkdir(exist_ok=True)
    with PATIENTS_FILE.open("w", encoding="utf-8") as file:
        json.dump(patients, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "4176"))
    server = ThreadingHTTPServer((host, port), VirtusHandler)
    print(f"Virtus Acompanha em http://{host}:{port}")
    server.serve_forever()
