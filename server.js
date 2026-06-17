import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const model = process.env.WORKSHOP_AI_MODEL || process.env.OPENAI_MODEL || process.env.OPENROUTER_MODEL || "openai/gpt-5.5";
const accessCode = process.env.WORKSHOP_ACCESS_CODE || "";
const allowedOrigins = (process.env.WORKSHOP_ALLOWED_ORIGINS || "https://4321onzin.github.io,http://localhost:4173,http://127.0.0.1:4173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const maxBodyBytes = 8 * 1024 * 1024;
const aiTimeoutMs = Number(process.env.WORKSHOP_AI_TIMEOUT_MS || 45000);
const rateWindowMs = Number(process.env.WORKSHOP_RATE_WINDOW_MS || 60_000);
const rateMaxRequests = Number(process.env.WORKSHOP_RATE_MAX || 20);
const requestCounts = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function json(req, res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("De aanvraag is te groot. Gebruik maximaal enkele foto's."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    const error = new Error("Ongeldige aanvraag.");
    error.status = 400;
    throw error;
  }
}

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function isRateLimited(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = requestCounts.get(key);
  if (!entry || now - entry.startedAt > rateWindowMs) {
    requestCounts.set(key, { count: 1, startedAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > rateMaxRequests;
}

function cleanCase(payload) {
  return {
    accessCode: String(payload.accessCode || "").trim(),
    vehicle: payload.vehicle || null,
    mileage: String(payload.mileage || "").slice(0, 20),
    faultCode: String(payload.faultCode || "").slice(0, 40),
    complaint: String(payload.complaint || "").slice(0, 1800),
    photos: Array.isArray(payload.photos) ? payload.photos.slice(0, 3) : [],
  };
}

function verifyAccess(req, res, input) {
  if (isRateLimited(req)) {
    json(req, res, 429, { ai: false, error: "Te veel verzoeken. Probeer het straks opnieuw." });
    return false;
  }
  if (!/^\d{4}$/.test(accessCode)) {
    json(req, res, 503, { ai: false, error: "WORKSHOP_ACCESS_CODE ontbreekt of is geen 4-cijferige code." });
    return false;
  }
  if (input.accessCode !== accessCode) {
    json(req, res, 401, { ai: false, error: "Toegangscode klopt niet." });
    return false;
  }
  return true;
}

function vehicleSummary(vehicle) {
  if (!vehicle) return "Geen RDW-voertuigdata opgehaald.";
  const fuel = Array.isArray(vehicle.brandstoffen)
    ? vehicle.brandstoffen.map((item) => item.brandstof_omschrijving).filter(Boolean).join(" + ")
    : "";
  return [
    "Kenteken: " + (vehicle.kenteken || "onbekend"),
    "Voertuig: " + (vehicle.merk || "onbekend") + " " + (vehicle.handelsbenaming || ""),
    "Datum eerste toelating: " + (vehicle.datum_eerste_toelating || "onbekend"),
    "Brandstof: " + (fuel || "onbekend"),
    "Massa ledig: " + (vehicle.massa_ledig_voertuig || "onbekend") + " kg",
    "APK vervalt: " + (vehicle.vervaldatum_apk || "onbekend"),
  ].join("\n");
}

function parseModelJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AI gaf geen JSON terug.");
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item?.step || item?.expectedResult) {
        return [item.step, item.expectedResult ? "Verwacht: " + item.expectedResult : ""].filter(Boolean).join(" ");
      }
      return JSON.stringify(item);
    });
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function normalizeAdvice(advice) {
  return {
    ...advice,
    summary: String(advice.summary || "Geen samenvatting ontvangen."),
    likelyCauses: normalizeList(advice.likelyCauses),
    checks: normalizeList(advice.checks),
    partsAndTools: normalizeList(advice.partsAndTools),
    customerText: String(advice.customerText || ""),
    warnings: normalizeList(advice.warnings),
  };
}

function normalizeChatMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const content = String(message?.content || "").slice(0, 1800);
  return content ? { role, content } : null;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI-provider reageerde niet binnen de timeout.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mockAdvice(input) {
  const fault = input.faultCode || "geen foutcode";
  return {
    ai: true,
    mock: true,
    summary: "Eerste AI-testadvies voor " + (input.vehicle?.merk || "het voertuig") + " " + (input.vehicle?.handelsbenaming || "") + " met foutcode " + fault + ".",
    likelyCauses: [
      "Basisconditie onbekend: begin met voeding, massa, vloeistoffen, zekeringen en visuele schade.",
      input.faultCode ? "Foutcode " + input.faultCode + " moet eerst met freeze-frame en live data worden beoordeeld." : "Zonder foutcode is klachtreproductie belangrijker dan onderdelen vervangen.",
      input.photos.length ? "De foto's moeten worden gebruikt om slijtage, lekkage of dashboardmeldingen te bevestigen." : "Foto's ontbreken; visuele controle blijft nodig.",
    ],
    checks: [
      "Reproduceer de klacht en noteer wanneer die optreedt: koud/warm, stationair, onder belasting of bij remmen.",
      "Lees alle modules uit en noteer actieve, opgeslagen en pending codes voordat je wist.",
      "Controleer bekende basisoorzaken die passen bij klacht en voertuig: accu/laadsysteem, massa, stekkers, vloeistofniveaus en lekkages.",
      "Meet voordat je onderdelen bestelt; gebruik live data of fysieke meting om de vermoedelijke oorzaak te bevestigen.",
    ],
    partsAndTools: ["OBD-scanner", "multimeter", "basis handgereedschap", "lamp/spiegel", "rooktester indien inlaat/vacuum verdacht"],
    customerText: "We gaan eerst gericht meten en controleren voordat we onderdelen vervangen. Daarna kunnen we duidelijk aangeven wat nodig is en wat het kost.",
    warnings: ["Dit is diagnosehulp, geen definitieve reparatie-uitspraak.", "Volg altijd merkprocedures en veiligheidsvoorschriften."],
  };
}

async function createAdvice(input) {
  if (process.env.WORKSHOP_AI_MOCK === "1") return mockAdvice(input);
  if (process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    return createOpenRouterAdvice(input);
  }
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY of OPENROUTER_API_KEY ontbreekt op de server.");
    error.status = 503;
    throw error;
  }
  const content = [
    {
      type: "input_text",
      text: [
        "Maak een praktisch werkplaatsadvies in het Nederlands.",
        "Geef geen absolute zekerheid. Werk met waarschijnlijkheden, controlevolgorde en meetstappen.",
        "Adviseer nooit blind onderdelen vervangen. Zeg expliciet welke meting of observatie nodig is.",
        "Antwoord uitsluitend als compacte JSON met keys: summary, likelyCauses, checks, partsAndTools, customerText, warnings.",
        "",
        "Voertuiggegevens:",
        vehicleSummary(input.vehicle),
        "",
        "Kilometerstand: " + (input.mileage || "onbekend"),
        "Foutcode: " + (input.faultCode || "geen"),
        "Klacht/opdracht: " + (input.complaint || "niet ingevuld"),
      ].join("\n"),
    },
  ];
  for (const photo of input.photos) {
    if (typeof photo?.dataUrl === "string" && photo.dataUrl.startsWith("data:image/")) {
      content.push({ type: "input_image", image_url: photo.dataUrl });
    }
  }
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "OpenAI gaf geen bruikbaar antwoord.");
    error.status = response.status;
    throw error;
  }
  const outputText =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n");
  if (!outputText) throw new Error("AI gaf geen tekst terug.");
  return { ai: true, model, ...normalizeAdvice(parseModelJson(outputText)) };
}

async function createOpenRouterAdvice(input) {
  const text = [
    "Maak een praktisch werkplaatsadvies in het Nederlands.",
    "Geef geen absolute zekerheid. Werk met waarschijnlijkheden, controlevolgorde en meetstappen.",
    "Adviseer nooit blind onderdelen vervangen. Zeg expliciet welke meting of observatie nodig is.",
    "Antwoord uitsluitend als compacte JSON met keys: summary, likelyCauses, checks, partsAndTools, customerText, warnings.",
    "",
    "Voertuiggegevens:",
    vehicleSummary(input.vehicle),
    "",
    "Kilometerstand: " + (input.mileage || "onbekend"),
    "Foutcode: " + (input.faultCode || "geen"),
    "Klacht/opdracht: " + (input.complaint || "niet ingevuld"),
  ].join("\n");

  const content = [{ type: "text", text }];
  for (const photo of input.photos) {
    if (typeof photo?.dataUrl === "string" && photo.dataUrl.startsWith("data:image/")) {
      content.push({ type: "image_url", image_url: { url: photo.dataUrl } });
    }
  }

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
      "content-type": "application/json",
      "http-referer": "https://4321onzin.github.io/werkplaats-assistent/",
      "x-title": "Werkplaats Assistent",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "OpenRouter gaf geen bruikbaar antwoord.");
    error.status = response.status;
    throw error;
  }
  const outputText = data.choices?.[0]?.message?.content;
  if (!outputText) throw new Error("AI gaf geen tekst terug.");
  return { ai: true, model, provider: "openrouter", ...normalizeAdvice(parseModelJson(outputText)) };
}

function caseContext(input) {
  return [
    "Je bent een praktische AI-werkplaatsassistent voor automonteurs.",
    "Antwoord in het Nederlands, kort maar bruikbaar.",
    "Werk met controles, meetstappen en waarschijnlijkheden. Doe niet alsof je zeker weet wat defect is.",
    "Adviseer niet blind onderdelen vervangen; koppel vervanging aan meting of observatie.",
    "",
    "Voertuiggegevens:",
    vehicleSummary(input.vehicle),
    "",
    "Kilometerstand: " + (input.mileage || "onbekend"),
    "Foutcode: " + (input.faultCode || "geen"),
    "Klacht/opdracht: " + (input.complaint || "niet ingevuld"),
    "Aantal foto's in dossier: " + input.photos.length,
  ].join("\n");
}

function mockChat(input) {
  const last = input.messages.at(-1)?.content || "Maak een eerste advies.";
  return {
    ai: true,
    mock: true,
    reply:
      "Ik zou dit stap voor stap aanpakken. Je vraag was: " +
      last +
      " Begin met foutcodes en freeze-frame data, controleer daarna visueel stekkers/slangen/vloeistoffen en meet pas daarna gericht aan het verdachte systeem.",
  };
}

async function createChatReply(input) {
  if (process.env.WORKSHOP_AI_MOCK === "1") return mockChat(input);
  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY of OPENROUTER_API_KEY ontbreekt op de server.");
    error.status = 503;
    throw error;
  }

  const messages = [
    { role: "system", content: caseContext(input) },
    ...input.messages.slice(-12).map(normalizeChatMessage).filter(Boolean),
  ];

  if (process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: messages,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || "OpenAI gaf geen bruikbaar antwoord.");
      error.status = response.status;
      throw error;
    }
    const reply =
      data.output_text ||
      data.output
        ?.flatMap((item) => item.content || [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text)
        .join("\n");
    if (!reply) throw new Error("AI gaf geen tekst terug.");
    return { ai: true, model, reply };
  }

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
      "content-type": "application/json",
      "http-referer": "https://4321onzin.github.io/werkplaats-assistent/",
      "x-title": "Werkplaats Assistent",
    },
    body: JSON.stringify({ model, messages }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "OpenRouter gaf geen bruikbaar antwoord.");
    error.status = response.status;
    throw error;
  }
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error("AI gaf geen tekst terug.");
  return { ai: true, model, provider: "openrouter", reply };
}

async function handleDiagnose(req, res) {
  try {
    const payload = await readJson(req);
    const input = cleanCase(payload);
    if (!verifyAccess(req, res, input)) return;
    const advice = await createAdvice(input);
    json(req, res, 200, advice);
  } catch (error) {
    json(req, res, error.status || 500, {
      ai: false,
      error: error.message || "Diagnose mislukt.",
    });
  }
}

async function handleChat(req, res) {
  try {
    const payload = await readJson(req);
    const input = {
      ...cleanCase(payload),
      messages: Array.isArray(payload.messages) ? payload.messages.slice(-12) : [],
    };
    if (!verifyAccess(req, res, input)) return;
    const reply = await createChatReply(input);
    json(req, res, 200, reply);
  } catch (error) {
    json(req, res, error.status || 500, {
      ai: false,
      error: error.message || "Chat mislukt.",
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://" + req.headers.host);
  const requestPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requestPath).replace(/^\.\.(\/|\\|$)/, "");
  const filePath = join(root, safePath);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": requestPath === "/index.html" ? "no-store" : "public, max-age=300",
    });
    res.end(body);
  } catch {
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-store" });
    res.end(body);
  }
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS" && (req.url === "/api/diagnose" || req.url === "/api/chat")) {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/api/diagnose") {
    handleDiagnose(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res);
    return;
  }
  if (req.url?.startsWith("/api/")) {
    json(req, res, 405, { error: "Methode niet toegestaan." });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  json(req, res, 405, { error: "Methode niet toegestaan." });
});

server.listen(port, host, () => {
  console.log("Werkplaats Assistent draait op http://" + host + ":" + port);
});
