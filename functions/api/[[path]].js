import crypto from "node:crypto";
import { Client } from "pg";

const SESSION_MAX_AGE = 60 * 60 * 12;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PATIENTS = 5000;
const MAX_AUDIT_EVENTS = 200;
const PATIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_KEYS = new Set(["password", "token", "formToken", "virtus_session", "session"]);
const ALLOWED_DECISIONS = new Set([
  "Manter retorno",
  "Postergar para 30 dias",
  "Postergar para 60 dias",
  "Solicitar contato",
  "Antecipar consulta",
]);
const FOLLOWUP_OPTIONS = {
  improvement: new Set(["Muito pior", "Pior", "Sem mudanças", "Melhor", "Muito melhor"]),
  adherence: new Set(["Sim", "Parcialmente", "Não"]),
  sideEffects: new Set(["Sim", "Não"]),
  sleep: new Set(["Muito ruim", "Ruim", "Regular", "Bom", "Muito bom"]),
  symptoms: new Set(["Muito piores", "Piores", "Sem mudanças", "Melhores", "Muito melhores"]),
};
let runtimeEnv = {};
let databaseReady = false;

function envValue(key) {
  return runtimeEnv?.[key] || "";
}

function allowedOrigins() {
  return new Set(
    (envValue("ALLOWED_ORIGINS") || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function jsonResponse(statusCode, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: new Headers(securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    })),
  });
}

function emptyResponse(statusCode, headers = {}) {
  return new Response("", {
    status: statusCode,
    headers: new Headers(securityHeaders(headers)),
  });
}

function normalizePath(event) {
  try {
    const originalPath = new URL(event.rawUrl || "").pathname;
    if (originalPath.startsWith("/api")) return originalPath;
  } catch {
    // Fall back to event.path below.
  }

  let path = event.path || "/api";
  path = path.replace(/^\/\.netlify\/functions\/api/, "/api");
  if (!path.startsWith("/api")) path = `/api/${path.replace(/^\/+/, "")}`;
  return path;
}

function validateConfiguration() {
  const errors = [];
  if (!envValue("ADMIN_PASSWORD")) errors.push("ADMIN_PASSWORD é obrigatório no Cloudflare");
  if (!databaseConnectionString()) errors.push("HYPERDRIVE ou DATABASE_URL é obrigatório no Cloudflare");
  if (envValue("SESSION_SECRET").length < 32) errors.push("SESSION_SECRET deve ter pelo menos 32 caracteres");
  if (errors.length) throw new Error(errors.join("; "));
}

function getPool() {
  return {
    async query(text, values) {
      const client = new Client(databaseClientOptions());
      await client.connect();
      try {
        return await client.query(text, values);
      } finally {
        await client.end();
      }
    },
  };
}

function databaseClientOptions() {
  const options = { connectionString: databaseConnectionString() };
  if (!runtimeEnv?.HYPERDRIVE?.connectionString) {
    options.ssl = { rejectUnauthorized: false };
  }
  return options;
}

function databaseConnectionString() {
  const rawConnectionString = runtimeEnv?.HYPERDRIVE?.connectionString || envValue("DATABASE_URL");
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("sslcert");
    url.searchParams.delete("sslkey");
    url.searchParams.delete("sslrootcert");
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

async function ensureDatabase() {
  if (databaseReady) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS virtus_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL
    )
  `);
  databaseReady = true;
}

async function checkDatabase() {
  await getPool().query("SELECT 1");
}

async function readState(stateId) {
  await ensureDatabase();
  const result = await getPool().query("SELECT payload FROM virtus_state WHERE id = $1", [stateId]);
  return result.rows[0]?.payload || [];
}

async function writeState(stateId, payload) {
  await ensureDatabase();
  await getPool().query(
    `
    INSERT INTO virtus_state (id, payload)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (id)
    DO UPDATE SET payload = EXCLUDED.payload
    `,
    [stateId, JSON.stringify(payload)],
  );
}

async function readPatients() {
  return readState("patients");
}

async function writePatients(patients) {
  await writeState("patients", patients);
}

async function readAuditEvents() {
  return readState("audit_events");
}

async function writeAuditEvents(events) {
  await writeState("audit_events", events.slice(0, MAX_AUDIT_EVENTS));
}

async function recordAuditEvent(type, patientId = "", actor = "system") {
  try {
    const event = {
      id: crypto.randomBytes(12).toString("base64url"),
      type: cleanText(type, 80),
      patientId: cleanText(patientId, 80),
      actor: cleanText(actor, 40),
      createdAt: new Date().toISOString(),
    };
    const events = await readAuditEvents();
    await writeAuditEvents([event, ...events]);
  } catch (error) {
    console.error(`Falha ao registrar auditoria: ${error.constructor.name}`);
  }
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...parts] = cookie.split("=");
        return [name, parts.join("=")];
      }),
  );
}

function sign(payload) {
  return crypto.createHmac("sha256", envValue("SESSION_SECRET")).update(payload).digest("hex");
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSessionToken() {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const payload = `admin:${expires}:${nonce}`;
  return Buffer.from(`${payload}:${sign(payload)}`, "utf8").toString("base64url");
}

function verifySessionToken(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [user, expires, nonce, signature] = decoded.split(":");
    const payload = `${user}:${expires}:${nonce}`;
    const expected = sign(payload);
    return (
      user === "admin" &&
      Number(expires) > Math.floor(Date.now() / 1000) &&
      safeCompare(signature, expected)
    );
  } catch {
    return false;
  }
}

function isAuthenticated(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || "");
  return Boolean(cookies.virtus_session && verifySessionToken(cookies.virtus_session));
}

function sessionCookie(token) {
  return `virtus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}; Secure`;
}

function expiredSessionCookie() {
  return "virtus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure";
}

function requireAuth(event) {
  if (isAuthenticated(event)) return null;
  return jsonResponse(401, { error: "Login obrigatório" });
}

function requireSameOrigin(event) {
  const origin = event.headers.origin || event.headers.Origin || event.headers.referer || event.headers.Referer;
  if (!origin) return jsonResponse(403, { error: "Origem obrigatória" });

  const host = event.headers.host || event.headers.Host || "";
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return jsonResponse(403, { error: "Origem não autorizada" });
  }
  const originBase = `${parsedOrigin.protocol}//${parsedOrigin.host}`;
  if (parsedOrigin.host === host || allowedOrigins().has(originBase)) return null;
  return jsonResponse(403, { error: "Origem não autorizada" });
}

function parseBody(event) {
  const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error("Content-Type deve ser application/json"), { statusCode: 415 });
  }

  const bodyText = event.body || "{}";

  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Requisição muito grande"), { statusCode: 413 });
  }

  try {
    return JSON.parse(bodyText || "{}");
  } catch {
    throw Object.assign(new Error("JSON inválido"), { statusCode: 400 });
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanEnum(value, allowedValues, fieldName) {
  const normalized = cleanText(value, 80);
  if (!allowedValues.has(normalized)) throw new Error(`${fieldName} inválido`);
  return normalized;
}

function cleanDate(value, fieldName, required = false) {
  const dateValue = cleanText(value, 10);
  if (!dateValue && !required) return "";
  if (!DATE_PATTERN.test(dateValue)) throw new Error(`${fieldName} inválida`);
  return dateValue;
}

function cleanPhone(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 16);
}

function cleanPatientId(value) {
  const patientId = cleanText(value, 80);
  if (PATIENT_ID_PATTERN.test(patientId)) return patientId;
  return `patient-${crypto.randomBytes(12).toString("base64url")}`;
}

function normalizePatientRecord(patient) {
  if (!patient || typeof patient !== "object") throw new Error("Paciente inválido");
  const normalized = {
    id: cleanPatientId(patient.id),
    name: cleanText(patient.name, 120),
    phone: cleanPhone(patient.phone),
    birthdate: cleanDate(patient.birthdate, "Data de nascimento"),
    doctor: cleanText(patient.doctor, 120),
    lastVisit: cleanDate(patient.lastVisit, "Última consulta"),
    returnDate: cleanDate(patient.returnDate, "Retorno previsto"),
    status: cleanText(patient.status, 80),
    classification: cleanText(patient.classification, 20),
    action: cleanText(patient.action, 180),
    summary: cleanText(patient.summary, 600),
    notes: cleanText(patient.notes, 600),
    decision: cleanText(patient.decision, 80),
    returnSentAt: cleanText(patient.returnSentAt, 40),
    formToken: cleanText(patient.formToken, 160) || crypto.randomBytes(32).toString("base64url"),
  };
  if (!normalized.name) throw new Error("Nome do paciente é obrigatório");
  return normalized;
}

function prepareRegisteredPatient(patient) {
  const normalized = {
    id: cleanPatientId(patient.id),
    name: cleanText(patient.name, 120),
    phone: cleanPhone(patient.phone),
    birthdate: cleanDate(patient.birthdate, "Data de nascimento", true),
    doctor: cleanText(patient.doctor, 120),
    lastVisit: cleanDate(patient.lastVisit, "Última consulta", true),
    returnDate: cleanDate(patient.returnDate, "Retorno previsto", true),
    status: "WhatsApp pendente",
    classification: "Pendente",
    action: "Enviar formulário de acompanhamento pelo WhatsApp",
    summary: "Paciente cadastrado e aguardando resposta do formulário de acompanhamento.",
    notes: "",
    decision: "",
    returnSentAt: "",
    formToken: crypto.randomBytes(32).toString("base64url"),
  };

  if (!normalized.name) throw new Error("Nome do paciente é obrigatório");
  if (!normalized.phone) throw new Error("WhatsApp é obrigatório");
  if (!normalized.doctor) throw new Error("Médico é obrigatório");
  return normalized;
}

function publicPatient(patient) {
  return {
    id: patient.id,
    name: patient.name,
    birthdate: patient.birthdate,
    status: patient.status,
    classification: patient.classification,
    returnDate: patient.returnDate,
    lastVisit: patient.lastVisit,
  };
}

function classifyResponse(data) {
  let score = 0;
  if (["Muito pior", "Pior"].includes(data.improvement)) score += 3;
  if (data.improvement === "Sem mudanças") score += 1;
  if (data.adherence === "Parcialmente") score += 1;
  if (data.adherence === "Não") score += 3;
  if (data.sideEffects === "Sim") score += 2;
  if (["Muito ruim", "Ruim"].includes(data.sleep)) score += 2;
  if (data.sleep === "Regular") score += 1;
  if (["Muito piores", "Piores"].includes(data.symptoms)) score += 3;
  if (data.symptoms === "Sem mudanças") score += 1;
  if (score >= 5) return "Vermelho";
  if (score >= 2) return "Amarelo";
  return "Verde";
}

function actionForClassification(classification) {
  return {
    Verde: "Avaliar postergar retorno para 30 ou 60 dias",
    Amarelo: "Manter retorno previamente agendado",
    Vermelho: "Destacar para avaliação médica prioritária",
  }[classification] || "Revisar acompanhamento";
}

function buildSummary(data) {
  const sideEffectText = data.sideEffects === "Sim"
    ? `efeito colateral informado: ${cleanText(data.sideEffectDetail, 300) || "sem detalhe"}`
    : "sem efeitos colaterais importantes";
  const notes = cleanText(data.notes, 600);
  const notesText = notes ? ` Informação adicional: ${notes}.` : "";
  return (
    `Paciente relata evolução "${cleanText(data.improvement, 40)}", ` +
    `adesão "${cleanText(data.adherence, 40)}", sono "${cleanText(data.sleep, 40)}", ` +
    `sintomas "${cleanText(data.symptoms, 40)}" e ${sideEffectText}.${notesText}`
  );
}

function applyResponse(patient, data) {
  for (const [fieldName, allowedValues] of Object.entries(FOLLOWUP_OPTIONS)) {
    cleanEnum(data[fieldName], allowedValues, fieldName);
  }

  const classification = classifyResponse(data);
  return {
    ...patient,
    name: cleanText(data.name || patient.name, 120),
    birthdate: cleanDate(data.birthdate || patient.birthdate, "Data de nascimento"),
    status: "Formulário respondido",
    classification,
    action: actionForClassification(classification),
    summary: buildSummary(data),
    notes: cleanText(data.notes, 600),
    decision: "",
    returnSentAt: "",
  };
}

function queryParams(event) {
  const rawUrl = event.rawUrl || `https://${event.headers.host || "localhost"}${event.path || ""}`;
  return new URL(rawUrl).searchParams;
}

function validPatientAccess(event, patient) {
  const expectedToken = patient.formToken;
  const requestToken = queryParams(event).get("token") || "";
  if (!expectedToken || !requestToken) return false;
  return safeCompare(expectedToken, requestToken);
}

function patientIdFromPath(path, suffix = "") {
  return path.replace(/^\/api\/patients\//, "").replace(suffix, "");
}

async function route(event) {
  validateConfiguration();

  const method = event.httpMethod;
  const path = normalizePath(event);

  if (method === "GET" && path === "/api/session") {
    return jsonResponse(200, { authenticated: isAuthenticated(event), loginRequired: true });
  }

  if (method === "GET" && path === "/api/health") {
    try {
      await checkDatabase();
      return jsonResponse(200, { ok: true, database: "connected", target: databaseTargetInfo() });
    } catch (error) {
      console.error(redactLogValue(error.message || "Erro interno"));
      return jsonResponse(500, {
        ok: false,
        error: publicErrorMessage(error),
        code: String(error?.code || ""),
        detail: safeDiagnosticMessage(error),
        target: databaseTargetInfo(),
      });
    }
  }

  if (method === "POST" && path === "/api/login") {
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const payload = parseBody(event);
    const suppliedPassword = String(payload.password || "");
    if (!safeCompare(suppliedPassword, envValue("ADMIN_PASSWORD"))) {
      return jsonResponse(401, { error: "Senha inválida" });
    }

    return jsonResponse(200, { authenticated: true }, { "Set-Cookie": sessionCookie(createSessionToken()) });
  }

  if (method === "POST" && path === "/api/logout") {
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;
    return emptyResponse(204, { "Set-Cookie": expiredSessionCookie() });
  }

  if (method === "GET" && path === "/api/audit") {
    const authError = requireAuth(event);
    if (authError) return authError;
    return jsonResponse(200, await readAuditEvents());
  }

  if (method === "POST" && path === "/api/audit/export") {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;
    parseBody(event);
    await recordAuditEvent("data_exported", "", "admin");
    return jsonResponse(200, { ok: true });
  }

  if (method === "GET" && path === "/api/patients") {
    const authError = requireAuth(event);
    if (authError) return authError;
    return jsonResponse(200, await readPatients());
  }

  if (method === "POST" && path === "/api/patients") {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const patient = prepareRegisteredPatient(parseBody(event));
    const patients = await readPatients();
    if (patients.length >= MAX_PATIENTS) return jsonResponse(400, { error: "Limite de pacientes atingido" });
    patients.unshift(patient);
    await writePatients(patients);
    await recordAuditEvent("patient_registered", patient.id, "admin");
    return jsonResponse(200, patient);
  }

  if (method === "PUT" && path === "/api/patients") {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const payload = parseBody(event);
    if (!Array.isArray(payload)) return jsonResponse(400, { error: "A lista de pacientes é obrigatória" });
    if (payload.length > MAX_PATIENTS) return jsonResponse(400, { error: "Lista de pacientes muito grande" });
    await writePatients(payload.map(normalizePatientRecord));
    return jsonResponse(200, { ok: true });
  }

  if (method === "GET" && path.startsWith("/api/patients/")) {
    const patientId = patientIdFromPath(path);
    if (!PATIENT_ID_PATTERN.test(patientId)) return jsonResponse(404, { error: "Paciente não encontrado" });
    const patient = (await readPatients()).find((item) => item.id === patientId);
    if (!patient) return jsonResponse(404, { error: "Paciente não encontrado" });
    if (!validPatientAccess(event, patient)) return jsonResponse(403, { error: "Link inválido" });
    return jsonResponse(200, publicPatient(patient));
  }

  if (method === "POST" && path.startsWith("/api/patients/") && path.endsWith("/response")) {
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const patientId = patientIdFromPath(path, "/response");
    if (!PATIENT_ID_PATTERN.test(patientId)) return jsonResponse(404, { error: "Paciente não encontrado" });
    const payload = parseBody(event);
    const patients = await readPatients();
    const patient = patients.find((item) => item.id === patientId);
    if (!patient) return jsonResponse(404, { error: "Paciente não encontrado" });
    if (!validPatientAccess(event, patient)) return jsonResponse(403, { error: "Link inválido" });
    if (patient.status === "Formulário respondido") return jsonResponse(200, publicPatient(patient));

    const updatedPatient = applyResponse(patient, payload);
    await writePatients(patients.map((item) => (item.id === patientId ? updatedPatient : item)));
    await recordAuditEvent("patient_response", patientId, "patient");
    return jsonResponse(200, publicPatient(updatedPatient));
  }

  if (method === "PATCH" && path.startsWith("/api/patients/") && path.endsWith("/decision")) {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const patientId = patientIdFromPath(path, "/decision");
    if (!PATIENT_ID_PATTERN.test(patientId)) return jsonResponse(404, { error: "Paciente não encontrado" });
    const decision = cleanText(parseBody(event).decision, 80);
    if (!ALLOWED_DECISIONS.has(decision)) return jsonResponse(400, { error: "Decisão inválida" });

    const patients = await readPatients();
    let updatedPatient = null;
    const nextPatients = patients.map((patient) => {
      if (patient.id !== patientId) return patient;
      updatedPatient = {
        ...patient,
        decision,
        returnSentAt: "",
        status: "Decisão médica registrada",
        action: `${decision} definido pelo médico`,
      };
      return updatedPatient;
    });
    if (!updatedPatient) return jsonResponse(404, { error: "Paciente não encontrado" });

    await writePatients(nextPatients);
    await recordAuditEvent("medical_decision", patientId, "admin");
    return jsonResponse(200, updatedPatient);
  }

  if (method === "PATCH" && path.startsWith("/api/patients/") && path.endsWith("/sent")) {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const patientId = patientIdFromPath(path, "/sent");
    if (!PATIENT_ID_PATTERN.test(patientId)) return jsonResponse(404, { error: "Paciente não encontrado" });
    const patients = await readPatients();
    let updatedPatient = null;
    const nextPatients = patients.map((patient) => {
      if (patient.id !== patientId) return patient;
      updatedPatient = {
        ...patient,
        status: "WhatsApp enviado",
        action: "Aguardando resposta do formulário",
      };
      return updatedPatient;
    });
    if (!updatedPatient) return jsonResponse(404, { error: "Paciente não encontrado" });

    await writePatients(nextPatients);
    await recordAuditEvent("whatsapp_sent", patientId, "admin");
    return jsonResponse(200, updatedPatient);
  }

  if (method === "PATCH" && path.startsWith("/api/patients/") && path.endsWith("/return-sent")) {
    const authError = requireAuth(event);
    if (authError) return authError;
    const sameOriginError = requireSameOrigin(event);
    if (sameOriginError) return sameOriginError;

    const patientId = patientIdFromPath(path, "/return-sent");
    if (!PATIENT_ID_PATTERN.test(patientId)) return jsonResponse(404, { error: "Paciente não encontrado" });
    const sentAt = cleanText(parseBody(event).sentAt, 40) || new Date().toISOString();
    const patients = await readPatients();
    let updatedPatient = null;
    const nextPatients = patients.map((patient) => {
      if (patient.id !== patientId) return patient;
      updatedPatient = {
        ...patient,
        returnSentAt: sentAt,
      };
      return updatedPatient;
    });
    if (!updatedPatient) return jsonResponse(404, { error: "Paciente não encontrado" });

    await writePatients(nextPatients);
    await recordAuditEvent("patient_return_sent", patientId, "admin");
    return jsonResponse(200, updatedPatient);
  }

  return jsonResponse(404, { error: "Rota não encontrada" });
}

export async function onRequest(context) {
  runtimeEnv = context.env || {};
  const event = await cloudflareEvent(context.request);
  try {
    return await route(event);
  } catch (error) {
    console.error(redactLogValue(error.message || "Erro interno"));
    return jsonResponse(error.statusCode || 500, {
      error: error.statusCode ? error.message : publicErrorMessage(error),
    });
  }
}

async function cloudflareEvent(request) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const body = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
  return {
    body,
    headers,
    httpMethod: request.method,
    path: url.pathname,
    rawUrl: request.url,
  };
}

function publicErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();

  if (message.includes("password authentication failed") || code === "28p01") {
    return "O banco de dados recusou a senha. Confira a conexão configurada no Cloudflare Hyperdrive.";
  }

  if (message.includes("self-signed certificate") || code === "self_signed_cert_in_chain") {
    return "O certificado SSL do banco foi recusado. O app precisa ignorar a validação da cadeia do certificado do pooler.";
  }

  if (
    message.includes("network is unreachable") ||
    message.includes("connection refused") ||
    message.includes("timeout") ||
    code === "enotfound" ||
    code === "econnrefused" ||
    code === "etimedout"
  ) {
    return "Não foi possível conectar ao banco de dados. Confira se o Hyperdrive aponta para o pooler do Supabase.";
  }

  return "Erro interno do servidor. Verifique os logs das funções no Cloudflare.";
}

function databaseTargetInfo() {
  const connectionString = databaseConnectionString();
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port,
      user: decodeURIComponent(url.username || ""),
      database: url.pathname.replace(/^\//, ""),
    };
  } catch {
    return { host: "", port: "", user: "", database: "", invalidUrl: true };
  }
}

function safeDiagnosticMessage(error) {
  let message = redactLogValue(error?.message || "Erro interno");
  const connectionString = databaseConnectionString();
  if (connectionString) message = message.replaceAll(connectionString, "DATABASE_URL_REDACTED");
  message = message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://REDACTED@");
  return message.slice(0, 300);
}

function redactLogValue(value) {
  let redacted = String(value || "");
  for (const key of SENSITIVE_KEYS) {
    redacted = redacted.replace(new RegExp(`(${key}=)[^&\\s]+`, "gi"), "$1REDACTED");
  }
  return redacted;
}
