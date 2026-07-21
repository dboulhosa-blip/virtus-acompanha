const STORAGE_KEY = "virtus-acompanha-patients";
const API_URL = "/api/patients";
const FOLLOWUP_DELAY_DAYS = 12;
const PUBLIC_APP_URL = "https://virtus-acompanha.onrender.com/";

const initialPatients = [];

const state = {
  activeView: "dashboard",
  classificationFilter: "Todos",
  doctorFilter: "Todos",
  dateFilter: "",
  search: "",
};

const tableBody = document.querySelector("#patient-table");
const auditList = document.querySelector("#audit-list");
const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginOutput = document.querySelector("#login-output");
const doctorCards = document.querySelector("#doctor-cards");
const doctorFilter = document.querySelector("#doctor-filter");
const dateFilter = document.querySelector("#date-filter");
const searchInput = document.querySelector("#search-input");
const sideEffects = document.querySelector("#side-effects");
const sideEffectDetail = document.querySelector("#side-effect-detail");
const form = document.querySelector("#followup-form");
const responseStatus = document.querySelector("#response-status");
const responseStatusTitle = document.querySelector("#response-status-title");
const responseStatusMessage = document.querySelector("#response-status-message");
const registrationForm = document.querySelector("#registration-form");
const classificationOutput = document.querySelector("#classification-output");
const registrationOutput = document.querySelector("#registration-output");
const registrationMessage = document.querySelector("#registration-message");
const registrationWhatsapp = document.querySelector("#registration-whatsapp");
const refreshButton = document.querySelector("#refresh-data");
const exportButton = document.querySelector("#export-data");
const logoutButton = document.querySelector("#logout-button");
const focusFormButton = document.querySelector("[data-focus-form]");
const historyModal = document.querySelector("#history-modal");
const historyTitle = document.querySelector("#history-title");
const historySubtitle = document.querySelector("#history-subtitle");
const historyList = document.querySelector("#history-list");
const closeHistoryButton = document.querySelector("#close-history");

let patients = [];
let auditEvents = [];
let isApiStorageAvailable = false;
let isAuthenticated = false;

function loadLocalPatients() {
  try {
    const storedPatients = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(storedPatients) && storedPatients.length
      ? storedPatients
      : [...initialPatients];
  } catch {
    return [...initialPatients];
  }
}

function saveLocalPatients() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(patients));
}

function isLocalFallbackAllowed() {
  return (
    window.location.protocol === "file:" ||
    ["localhost", "127.0.0.1", ""].includes(window.location.hostname)
  );
}

function showOperationalError(message) {
  classificationOutput.textContent = message;
  registrationOutput.textContent = message;
}

async function loadPatients() {
  if (isLocalFallbackAllowed() && window.location.protocol === "file:") {
    return loadLocalPatients();
  }

  try {
    const patientId = getPatientIdFromUrl();
    const response = await fetch(patientId ? patientApiUrl(patientId) : API_URL);
    if (!response.ok) throw new Error("API indisponível");
    const apiPatients = await response.json();
    isApiStorageAvailable = true;
    if (patientId) return apiPatients?.id ? [apiPatients] : [];
    return Array.isArray(apiPatients) ? apiPatients : [...initialPatients];
  } catch {
    isApiStorageAvailable = false;
    if (getPatientIdFromUrl()) {
      classificationOutput.textContent = "Não foi possível validar este link no servidor.";
      return [];
    }
    showOperationalError("Não foi possível carregar os dados do servidor.");
    return [];
  }
}

async function loadAuditEvents() {
  if (window.location.protocol === "file:" || !isAuthenticated) return [];

  try {
    return await apiRequest("/api/audit");
  } catch {
    return [];
  }
}

async function savePatients() {
  if (isLocalFallbackAllowed() && window.location.protocol === "file:") {
    saveLocalPatients();
    return;
  }

  if (!isApiStorageAvailable) {
    throw new Error("API indisponível");
  }

  try {
    const response = await fetch(API_URL, {
      body: JSON.stringify(patients),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
    });

    if (!response.ok) throw new Error("Falha ao salvar na API");
  } catch {
    isApiStorageAvailable = false;
    throw new Error("Falha ao salvar na API");
  }
}

function createElement(tag, options = {}) {
  const element = document.createElement(tag);

  if (options.className) element.className = options.className;
  if (options.text) element.textContent = options.text;
  if (options.type) element.type = options.type;
  if (options.value) element.value = options.value;
  if (options.colSpan) element.colSpan = options.colSpan;
  if (options.href) element.href = options.href;
  if (options.target) element.target = options.target;
  if (options.rel) element.rel = options.rel;

  return element;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) throw new Error("Falha na comunicação com o servidor");
  if (response.status === 204) return null;
  return response.json();
}

function getPatientIdFromUrl() {
  return new URLSearchParams(window.location.search).get("patient");
}

function getPatientTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("token");
}

function patientApiUrl(patientId, suffix = "") {
  const url = new URL(`${API_URL}/${patientId}${suffix}`, window.location.origin);
  const token = getPatientTokenFromUrl();
  if (token) url.searchParams.set("token", token);
  return `${url.pathname}${url.search}`;
}

async function checkSession() {
  if (window.location.protocol === "file:" || isPatientFormLink()) {
    isAuthenticated = true;
    return true;
  }

  try {
    const session = await apiRequest("/api/session");
    isAuthenticated = session.authenticated;
    document.body.classList.toggle("login-required", !isAuthenticated);
    loginScreen.classList.toggle("is-hidden", isAuthenticated);
    return isAuthenticated;
  } catch {
    isAuthenticated = false;
    document.body.classList.add("login-required");
    loginScreen.classList.remove("is-hidden");
    return false;
  }
}

function formatDate(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function moveToPreviousBusinessDay(date) {
  const nextDate = new Date(date);
  const dayOfWeek = nextDate.getDay();

  if (dayOfWeek === 6) nextDate.setDate(nextDate.getDate() - 1);
  if (dayOfWeek === 0) nextDate.setDate(nextDate.getDate() - 2);

  return nextDate;
}

function parseLocalDate(date) {
  return date ? new Date(`${date}T12:00:00`) : null;
}

function getFollowupSendDate(patient) {
  const lastVisit = parseLocalDate(patient.lastVisit);
  if (!lastVisit || Number.isNaN(lastVisit.getTime())) return null;
  return moveToPreviousBusinessDay(addDays(lastVisit, FOLLOWUP_DELAY_DAYS));
}

function getSendSchedule(patient) {
  const sendDate = getFollowupSendDate(patient);

  if (!sendDate) {
    return {
      dateText: "Data pendente",
      label: "Aguardando consulta",
      state: "waiting",
    };
  }

  const dateText = formatDate(toDateInputValue(sendDate));

  if (patient.status === "Formulário respondido") {
    return {
      dateText,
      label: "Respondido",
      state: "done",
    };
  }

  if (patient.status === "WhatsApp enviado") {
    return {
      dateText,
      label: "Enviado",
      state: "done",
    };
  }

  const today = parseLocalDate(toDateInputValue(new Date()));
  const isReady = sendDate <= today;

  return {
    dateText,
    label: isReady ? "Pronto para envio" : `Aguardando dia ${dateText}`,
    state: isReady ? "ready" : "waiting",
  };
}

function badgeClass(classification) {
  return `badge badge-${classification.toLowerCase()}`;
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function getPublicAppUrl() {
  const isLocalAddress = ["", "localhost", "127.0.0.1"].includes(window.location.hostname);

  if (window.location.protocol === "https:" && !isLocalAddress) {
    return window.location.origin;
  }

  return PUBLIC_APP_URL;
}

function getPatientFormUrl(patient) {
  const url = new URL(getPublicAppUrl());
  url.hash = "formulario-paciente";

  if (patient?.id) url.searchParams.set("patient", patient.id);
  if (patient?.formToken) url.searchParams.set("token", patient.formToken);
  return url.toString();
}

function buildWhatsAppMessage(patient) {
  return [
    `Olá, ${patient.name}!`,
    "Como parte do acompanhamento do Instituto Virtus, gostaríamos de saber como você está evoluindo desde a última consulta.",
    "Para responder, toque no link abaixo:",
    getPatientFormUrl(patient),
  ].join("\n\n");
}

function getWhatsAppUrl(patient) {
  return `https://wa.me/${normalizePhone(patient.phone || "")}?text=${encodeURIComponent(
    buildWhatsAppMessage(patient),
  )}`;
}

function getActionForClassification(classification) {
  const actions = {
    Verde: "Avaliar possibilidade de postergar o retorno",
    Amarelo: "Manter retorno previamente agendado",
    Vermelho: "Destacar para avaliação médica prioritária",
  };

  return actions[classification];
}

function getFilteredPatients({ includeSearch = false } = {}) {
  return patients.filter((patient) => {
    const schedule = getSendSchedule(patient);
    const matchesClassification =
      state.classificationFilter === "Todos" ||
      (state.classificationFilter === "Pronto para envio" &&
        schedule.state === "ready" &&
        patient.status !== "WhatsApp enviado") ||
      patient.classification === state.classificationFilter;
    const matchesDoctor =
      state.doctorFilter === "Todos" || patient.doctor === state.doctorFilter;
    const matchesDate = !state.dateFilter || patient.returnDate === state.dateFilter;
    const matchesSearch =
      !includeSearch ||
      patient.name.toLowerCase().includes(state.search.toLowerCase().trim());

    return matchesClassification && matchesDoctor && matchesDate && matchesSearch;
  });
}

function statusPillClass(patient) {
  if (patient.decision) return "status-pill is-decided";
  if (patient.status === "WhatsApp enviado") return "status-pill is-sent";
  return "status-pill";
}

function renderMetrics() {
  document.querySelector("#metric-total").textContent = patients.length;
  document.querySelector("#metric-green").textContent = patients.filter(
    (patient) => patient.classification === "Verde",
  ).length;
  document.querySelector("#metric-yellow").textContent = patients.filter(
    (patient) => patient.classification === "Amarelo",
  ).length;
  document.querySelector("#metric-red").textContent = patients.filter(
    (patient) => patient.classification === "Vermelho",
  ).length;
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function auditEventLabel(event) {
  const labels = {
    current_status: "Status atual",
    data_exported: "Exportação operacional realizada",
    patient_registered: "Paciente cadastrado",
    whatsapp_sent: "WhatsApp marcado como enviado",
    patient_response: "Formulário respondido",
    medical_decision: "Decisão médica registrada",
  };

  return labels[event.type] || "Atividade registrada";
}

function renderAuditEvents() {
  auditList.replaceChildren();

  if (!auditEvents.length) {
    auditList.append(createElement("p", {
      className: "empty-state",
      text: "Nenhuma atividade registrada ainda.",
    }));
    return;
  }

  auditEvents.slice(0, 8).forEach((event) => {
    const item = createElement("article", { className: "activity-item" });
    const label = createElement("strong", { text: auditEventLabel(event) });
    const meta = createElement("span", {
      text: `${formatDateTime(event.createdAt)}${event.patientId ? ` - ${event.patientId}` : ""}`,
    });

    item.append(label, meta);
    auditList.append(item);
  });
}

function renderDoctorOptions() {
  const selectedDoctor = doctorFilter.value || "Todos";
  const doctors = [...new Set(patients.map((patient) => patient.doctor))].sort();

  doctorFilter.replaceChildren(createElement("option", { text: "Todos", value: "Todos" }));

  doctors.forEach((doctor) => {
    doctorFilter.append(createElement("option", { text: doctor, value: doctor }));
  });

  doctorFilter.value = doctors.includes(selectedDoctor) ? selectedDoctor : "Todos";
  state.doctorFilter = doctorFilter.value;
}

function renderTable() {
  const rows = getFilteredPatients();
  tableBody.replaceChildren();

  if (!rows.length) {
    const row = createElement("tr");
    const cell = createElement("td", {
      colSpan: 9,
      text: "Nenhum paciente encontrado para os filtros selecionados.",
    });
    row.append(cell);
    tableBody.append(row);
    return;
  }

  rows.forEach((patient) => {
    const row = createElement("tr");
    const patientCell = createElement("td");
    const name = createElement("span", {
      className: "patient-name",
      text: patient.name,
    });
    const meta = createElement("span", {
      className: "patient-meta",
      text: patient.phone ? `${patient.doctor} - ${patient.phone}` : patient.doctor,
    });
    const badge = createElement("span", {
      className: badgeClass(patient.classification),
      text: patient.classification,
    });
    const status = createElement("span", {
      className: statusPillClass(patient),
      text: patient.decision || patient.status,
    });
    const schedule = getSendSchedule(patient);
    const scheduleCell = createElement("td");
    const scheduleDate = createElement("span", {
      className: "send-date",
      text: schedule.dateText,
    });
    const scheduleStatus = createElement("span", {
      className: `schedule-pill is-${schedule.state}`,
      text: schedule.label,
    });

    scheduleCell.append(scheduleDate, scheduleStatus);
    patientCell.append(name, meta);
    row.append(
      patientCell,
      createElement("td", { text: formatDate(patient.lastVisit) }),
      scheduleCell,
      createElement("td", { text: formatDate(patient.returnDate) }),
      createElement("td"),
      createElement("td"),
      createElement("td", { text: patient.action }),
      createElement("td"),
      createElement("td"),
    );
    row.children[4].append(badge);
    row.children[5].append(status);
    row.children[7].append(createWhatsAppAction(patient));
    row.children[8].append(createHistoryAction(patient));
    tableBody.append(row);
  });
}

function createWhatsAppAction(patient) {
  if (!patient.phone) {
    return createElement("span", { className: "patient-meta", text: "Sem telefone" });
  }

  const action = createElement("a", {
    className: "table-action",
    href: getWhatsAppUrl(patient),
    target: "_blank",
    rel: "noreferrer",
    text: patient.status === "WhatsApp enviado" ? "Reenviar formulário" : "Enviar formulário",
  });

  action.addEventListener("click", () => markWhatsAppSent(patient.id));
  return action;
}

function createHistoryAction(patient) {
  const button = createElement("button", {
    className: "secondary-action",
    type: "button",
    text: "Histórico",
  });

  button.addEventListener("click", () => openPatientHistory(patient.id));
  return button;
}

function renderDoctorCards() {
  const cards = getFilteredPatients({ includeSearch: true });
  doctorCards.replaceChildren();

  if (!cards.length) {
    doctorCards.append(createElement("p", { className: "empty-state", text: "Nenhum card encontrado." }));
    return;
  }

  cards.forEach((patient) => {
    const card = createElement("article", { className: "patient-card" });
    const cardTop = createElement("div", { className: "card-top" });
    const patientInfo = createElement("div");
    const name = createElement("span", {
      className: "patient-name",
      text: patient.name,
    });
    const meta = createElement("span", {
      className: "patient-meta",
      text: `Consulta anterior: ${formatDate(patient.lastVisit)}${patient.phone ? ` - ${patient.phone}` : ""}`,
    });
    const badge = createElement("span", {
      className: badgeClass(patient.classification),
      text: patient.classification,
    });
    const summary = createElement("p", {
      className: "ai-summary",
      text: patient.summary,
    });
    const notes = createElement("p", {
      className: patient.notes ? "patient-note is-visible" : "patient-note",
      text: patient.notes ? `Informação adicional: ${patient.notes}` : "",
    });
    const decisions = createElement("div", { className: "decision-grid" });
    const feedback = createElement("p", {
      className: patient.decision ? "decision-note is-visible" : "decision-note",
      text: patient.decision ? `Decisão registrada: ${patient.decision}` : "",
    });

    ["Manter retorno", "Postergar retorno", "Solicitar contato", "Antecipar consulta"].forEach(
      (decision) => {
        const button = createElement("button", { type: "button", text: decision });
        button.classList.toggle("is-selected", patient.decision === decision);
        button.addEventListener("click", () => registerDecision(patient.id, decision));
        decisions.append(button);
      },
    );

    patientInfo.append(name, meta);
    cardTop.append(patientInfo, badge);
    card.append(cardTop, summary, notes, decisions, feedback);
    doctorCards.append(card);
  });
}

function render() {
  renderMetrics();
  renderDoctorOptions();
  renderTable();
  renderDoctorCards();
  renderAuditEvents();
}

function setView(view) {
  state.activeView = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("is-visible", section.id === `${view}-view`);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === view);
  });
}

function getLinkedPatient() {
  const patientId = getPatientIdFromUrl();
  return patients.find((patient) => patient.id === patientId);
}

function isPatientFormLink() {
  return (
    window.location.hash === "#formulario-paciente" &&
    new URLSearchParams(window.location.search).has("patient")
  );
}

function updatePatientMode() {
  document.body.classList.toggle("patient-mode", isPatientFormLink());
}

function hasPatientAlreadyAnswered(patient) {
  return patient?.status === "Formulário respondido";
}

function showResponseStatus(title, message) {
  responseStatusTitle.textContent = title;
  responseStatusMessage.textContent = message;
  responseStatus.classList.remove("is-hidden");
  form.classList.add("is-hidden");
}

function showResponseForm() {
  responseStatus.classList.add("is-hidden");
  form.classList.remove("is-hidden");
}

function applyLinkedPatientToForm() {
  const linkedPatient = getLinkedPatient();

  if (!linkedPatient) {
    showResponseStatus(
      "Link não encontrado",
      "Não encontramos este acompanhamento. Entre em contato com a equipe do Instituto Virtus.",
    );
    return;
  }

  if (hasPatientAlreadyAnswered(linkedPatient)) {
    showResponseStatus(
      "Resposta já registrada",
      "Obrigado. Seu acompanhamento já foi recebido pela equipe do Instituto Virtus.",
    );
    return;
  }

  showResponseForm();
  form.elements.name.value = linkedPatient.name;
  form.elements.birthdate.value = linkedPatient.birthdate || "";
  classificationOutput.textContent = `Resposta vinculada a ${linkedPatient.name}.`;
}

function openViewFromHash() {
  updatePatientMode();

  if (window.location.hash === "#formulario-paciente") {
    setView("form");
    applyLinkedPatientToForm();
    return;
  }

  if (window.location.hash === "#cadastro-paciente") {
    setView("registration");
  }
}

function classifyForm(data) {
  let score = 0;

  if (["Muito pior", "Pior"].includes(data.get("improvement"))) score += 3;
  if (data.get("improvement") === "Sem mudanças") score += 1;
  if (data.get("adherence") === "Parcialmente") score += 1;
  if (data.get("adherence") === "Não") score += 3;
  if (data.get("sideEffects") === "Sim") score += 2;
  if (["Muito ruim", "Ruim"].includes(data.get("sleep"))) score += 2;
  if (data.get("sleep") === "Regular") score += 1;
  if (["Muito piores", "Piores"].includes(data.get("symptoms"))) score += 3;
  if (data.get("symptoms") === "Sem mudanças") score += 1;

  if (score >= 5) return "Vermelho";
  if (score >= 2) return "Amarelo";
  return "Verde";
}

function buildSummary(data) {
  const sideEffectText =
    data.get("sideEffects") === "Sim"
      ? `efeito colateral informado: ${data.get("sideEffectDetail") || "sem detalhe"}`
      : "sem efeitos colaterais importantes";
  const notes = data.get("notes")?.trim();
  const notesText = notes ? ` Informação adicional: ${notes}.` : "";

  return `Paciente relata evolução "${data.get("improvement")}", adesão "${data.get(
    "adherence",
  )}", sono "${data.get("sleep")}", sintomas "${data.get("symptoms")}" e ${sideEffectText}.${notesText}`;
}

async function registerDecision(patientId, decision) {
  if (isApiStorageAvailable && window.location.protocol !== "file:") {
    const updatedPatient = await apiRequest(`${API_URL}/${patientId}/decision`, {
      body: JSON.stringify({ decision }),
      method: "PATCH",
    });
    patients = patients.map((patient) => (patient.id === patientId ? updatedPatient : patient));
    render();
    return;
  }

  if (!isLocalFallbackAllowed()) {
    classificationOutput.textContent = "Servidor indisponível. A decisão não foi salva.";
    return;
  }

  patients = patients.map((patient) =>
    patient.id === patientId
      ? {
          ...patient,
          decision,
          status: "Decisão médica registrada",
          action: `${decision} definido pelo médico`,
        }
      : patient,
  );
  await savePatients();
  render();
}

async function markWhatsAppSent(patientId) {
  const updatedPatient = {
    ...patients.find((patient) => patient.id === patientId),
    status: "WhatsApp enviado",
    action: "Aguardando resposta do formulário",
  };

  if (isApiStorageAvailable && window.location.protocol !== "file:") {
    try {
      const savedPatient = await apiRequest(`${API_URL}/${patientId}/sent`, {
        method: "PATCH",
      });
      patients = patients.map((patient) => (patient.id === patientId ? savedPatient : patient));
      render();
      return;
    } catch {
      classificationOutput.textContent = "Não foi possível marcar o WhatsApp como enviado.";
      return;
    }
  }

  if (!isLocalFallbackAllowed()) {
    classificationOutput.textContent = "Servidor indisponível. O envio não foi marcado.";
    return;
  }

  try {
    patients = patients.map((patient) => (patient.id === patientId ? updatedPatient : patient));
    await savePatients();
    render();
  } catch {
    classificationOutput.textContent = "Não foi possível marcar o WhatsApp como enviado.";
  }
}

async function createFollowup(data, linkedPatient = null) {
  const classification = classifyForm(data);
  const today = new Date();

  if (linkedPatient) {
    if (hasPatientAlreadyAnswered(linkedPatient)) return linkedPatient;

    if (isApiStorageAvailable && window.location.protocol !== "file:") {
      const updatedPatient = await apiRequest(patientApiUrl(linkedPatient.id, "/response"), {
        body: JSON.stringify(Object.fromEntries(data.entries())),
        method: "POST",
      });
      patients = patients.map((patient) =>
        patient.id === linkedPatient.id ? { ...patient, ...updatedPatient } : patient,
      );
      return { ...linkedPatient, ...updatedPatient };
    }

    const updatedPatient = {
      ...linkedPatient,
      name: data.get("name").trim(),
      birthdate: data.get("birthdate"),
      status: "Formulário respondido",
      classification,
      action: getActionForClassification(classification),
      summary: buildSummary(data),
      notes: data.get("notes")?.trim() || "",
      decision: "",
    };

    if (!isLocalFallbackAllowed()) {
      throw new Error("Servidor indisponível");
    }

    patients = patients.map((patient) =>
      patient.id === linkedPatient.id ? updatedPatient : patient,
    );
    await savePatients();
    return updatedPatient;
  }

  const patient = {
    id: `patient-${Date.now()}`,
    name: data.get("name").trim(),
    phone: "",
    birthdate: data.get("birthdate"),
    doctor: "Aguardando triagem",
    lastVisit: toDateInputValue(today),
    returnDate: toDateInputValue(addDays(today, 15)),
    status: "Formulário respondido",
    classification,
    action: getActionForClassification(classification),
    summary: buildSummary(data),
    notes: data.get("notes")?.trim() || "",
    decision: "",
  };

  if (!isLocalFallbackAllowed()) {
    throw new Error("Servidor indisponível");
  }

  patients = [patient, ...patients];
  await savePatients();
  return patient;
}

async function createRegisteredPatient(data) {
  const patient = {
    id: `patient-${Date.now()}`,
    formToken: createFormToken(),
    name: data.get("name").trim(),
    phone: normalizePhone(data.get("phone")),
    birthdate: data.get("birthdate"),
    doctor: data.get("doctor").trim(),
    lastVisit: data.get("lastVisit"),
    returnDate: data.get("returnDate"),
    status: "WhatsApp pendente",
    classification: "Pendente",
    action: "Enviar formulário de acompanhamento pelo WhatsApp",
    summary: "Paciente cadastrado e aguardando resposta do formulário de acompanhamento.",
    notes: "",
    decision: "",
  };

  if (isApiStorageAvailable && window.location.protocol !== "file:") {
    const savedPatient = await apiRequest(API_URL, {
      body: JSON.stringify(patient),
      method: "POST",
    });
    patients = [savedPatient, ...patients];
    return savedPatient;
  }

  if (!isLocalFallbackAllowed()) {
    throw new Error("Servidor indisponível");
  }

  patients = [patient, ...patients];
  await savePatients();
  return patient;
}

function createFormToken() {
  if (window.crypto?.getRandomValues) {
    const randomBytes = new Uint8Array(24);
    window.crypto.getRandomValues(randomBytes);
    return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  throw new Error("Gerador seguro indisponível");
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildOperationalExportRows() {
  return getFilteredPatients().map((patient) => {
    const schedule = getSendSchedule(patient);

    return [
      patient.name,
      patient.doctor,
      patient.phone,
      patient.lastVisit ? formatDate(patient.lastVisit) : "",
      schedule.dateText,
      patient.returnDate ? formatDate(patient.returnDate) : "",
      patient.classification,
      patient.decision || patient.status,
      patient.action,
      patient.decision,
    ];
  });
}

async function recordExportAudit(count) {
  if (!isApiStorageAvailable || window.location.protocol === "file:") return;

  try {
    await apiRequest("/api/audit/export", {
      body: JSON.stringify({ count }),
      method: "POST",
    });
    auditEvents = await loadAuditEvents();
    renderAuditEvents();
  } catch {
    // Export should still work if the audit service is temporarily unavailable.
  }
}

async function exportOperationalCsv() {
  const rows = buildOperationalExportRows();

  if (!rows.length) {
    classificationOutput.textContent = "Nenhum paciente encontrado para exportar.";
    return;
  }

  const headers = [
    "Paciente",
    "Médico",
    "WhatsApp",
    "Consulta",
    "Enviar em",
    "Retorno",
    "Classificação",
    "Status",
    "Ação sugerida",
    "Decisão médica",
  ];
  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(";"))
    .join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `virtus-acompanha-${toDateInputValue(new Date())}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  classificationOutput.textContent = `${rows.length} registro(s) exportado(s) sem token do formulário ou respostas clínicas livres.`;
  await recordExportAudit(rows.length);
}

function patientHistoryEvents(patient) {
  const events = auditEvents.filter((event) => event.patientId === patient.id);

  if (events.length) return events;

  return [
    {
      id: `current-${patient.id}`,
      type: "current_status",
      patientId: patient.id,
      actor: "system",
      createdAt: new Date().toISOString(),
    },
  ];
}

function historyEventDetail(event, patient) {
  const details = {
    current_status: patient.decision || patient.status,
    patient_registered: "Cadastro criado no acompanhamento.",
    whatsapp_sent: "Envio do formulário marcado no painel.",
    patient_response: "Resposta recebida e classificação atualizada.",
    medical_decision: patient.decision || "Decisão médica registrada.",
  };

  return details[event.type] || "Atividade operacional registrada.";
}

function openPatientHistory(patientId) {
  const patient = patients.find((item) => item.id === patientId);
  if (!patient) return;

  const schedule = getSendSchedule(patient);
  const events = patientHistoryEvents(patient);

  historyTitle.textContent = patient.name;
  historySubtitle.textContent = `${patient.doctor} - envio ${schedule.dateText} - retorno ${formatDate(patient.returnDate)}`;
  historyList.replaceChildren();

  events.forEach((event) => {
    const item = createElement("article", { className: "timeline-item" });
    const marker = createElement("span", { className: "timeline-marker" });
    const content = createElement("div");
    const label = createElement("strong", { text: auditEventLabel(event) });
    const meta = createElement("span", {
      text: `${formatDateTime(event.createdAt)} - ${historyEventDetail(event, patient)}`,
    });

    content.append(label, meta);
    item.append(marker, content);
    historyList.append(item);
  });

  historyModal.classList.remove("is-hidden");
  closeHistoryButton.focus();
}

function closePatientHistory() {
  historyModal.classList.add("is-hidden");
}

function updateRegistrationPreview(patient) {
  registrationMessage.textContent = buildWhatsAppMessage(patient);
  registrationWhatsapp.href = getWhatsAppUrl(patient);
  registrationWhatsapp.classList.remove("is-disabled");
}

document.querySelectorAll("[data-view], [data-view-link]").forEach((button) => {
  button.addEventListener("click", () => {
    setView(button.dataset.view || button.dataset.viewLink);
  });
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginOutput.textContent = "";

  try {
    const data = new FormData(loginForm);
    await apiRequest("/api/login", {
      body: JSON.stringify({ password: data.get("password") }),
      method: "POST",
    });
    loginForm.reset();
    document.body.classList.remove("login-required");
    loginScreen.classList.add("is-hidden");
    isAuthenticated = true;
    patients = await loadPatients();
    auditEvents = await loadAuditEvents();
    render();
  } catch {
    loginOutput.textContent = "Senha inválida. Tente novamente.";
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST" });
  } catch {
    // Even if the request fails, clear the interface so the user can try logging in again.
  }

  isAuthenticated = false;
  patients = [];
  auditEvents = [];
  loginForm.reset();
  loginOutput.textContent = "";
  document.body.classList.add("login-required");
  loginScreen.classList.remove("is-hidden");
});

window.addEventListener("hashchange", openViewFromHash);

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.classificationFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => {
      item.classList.toggle("is-active", item === button);
      item.setAttribute("aria-selected", item === button ? "true" : "false");
    });
    render();
  });
});

doctorFilter.addEventListener("change", (event) => {
  state.doctorFilter = event.target.value;
  renderTable();
  renderDoctorCards();
});

dateFilter.addEventListener("change", (event) => {
  state.dateFilter = event.target.value;
  renderTable();
  renderDoctorCards();
});

searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderDoctorCards();
});

document.querySelector("#clear-filters").addEventListener("click", () => {
  state.classificationFilter = "Todos";
  state.doctorFilter = "Todos";
  state.dateFilter = "";
  doctorFilter.value = "Todos";
  dateFilter.value = "";
  document.querySelectorAll("[data-filter]").forEach((item) => {
    const isActive = item.dataset.filter === "Todos";
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  render();
});

sideEffects.addEventListener("change", (event) => {
  sideEffectDetail.classList.toggle("is-hidden", event.target.value !== "Sim");
});

focusFormButton.addEventListener("click", () => {
  form.querySelector("input, select, textarea").focus();
});

refreshButton.addEventListener("click", async () => {
  try {
    patients = await loadPatients();
    auditEvents = await loadAuditEvents();
    classificationOutput.textContent = isApiStorageAvailable || isLocalFallbackAllowed()
      ? "Dados atualizados."
      : "Não foi possível atualizar os dados do servidor.";
    render();
  } catch {
    classificationOutput.textContent = "Não foi possível atualizar os dados.";
  }
});

exportButton.addEventListener("click", exportOperationalCsv);

closeHistoryButton.addEventListener("click", closePatientHistory);

historyModal.addEventListener("click", (event) => {
  if (event.target === historyModal) closePatientHistory();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !historyModal.classList.contains("is-hidden")) {
    closePatientHistory();
  }
});

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(registrationForm);

  try {
    const patient = await createRegisteredPatient(data);
    updateRegistrationPreview(patient);
    registrationOutput.textContent = "Paciente cadastrado. WhatsApp pronto para envio.";
    render();
    setView("dashboard");
  } catch {
    registrationOutput.textContent = "Não foi possível salvar. Verifique o servidor e tente novamente.";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const linkedPatient = getLinkedPatient();

  if (linkedPatient && hasPatientAlreadyAnswered(linkedPatient)) {
    showResponseStatus(
      "Resposta já registrada",
      "Obrigado. Seu acompanhamento já foi recebido pela equipe do Instituto Virtus.",
    );
    return;
  }

  let patient;
  try {
    patient = await createFollowup(data, linkedPatient);
    classificationOutput.textContent = linkedPatient
      ? `Classificação sugerida: ${patient.classification}. Cadastro de ${patient.name} atualizado.`
      : `Classificação sugerida: ${patient.classification}. Paciente incluído no painel.`;
    render();
  } catch {
    classificationOutput.textContent = "Não foi possível enviar a resposta. Tente novamente.";
    return;
  }

  if (linkedPatient) {
    showResponseStatus(
      "Resposta enviada",
      "Obrigado por responder o acompanhamento. A equipe do Instituto Virtus já recebeu suas informações.",
    );
    form.reset();
    return;
  }

  setView("dashboard");
});

document.querySelectorAll("[data-filter]").forEach((item) => {
  item.setAttribute("aria-selected", item.classList.contains("is-active") ? "true" : "false");
});

async function initializeApp() {
  const canLoadPatients = await checkSession();
  if (!canLoadPatients) return;

  patients = await loadPatients();
  auditEvents = await loadAuditEvents();
  render();
  openViewFromHash();
}

initializeApp();
