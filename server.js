import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const model = process.env.OPENAI_MODEL || "gpt-5.5";
const maxBodyBytes = 8 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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

function cleanCase(payload) {
  return {
    vehicle: payload.vehicle || null,
    mileage: String(payload.mileage || "").slice(0, 20),
    faultCode: String(payload.faultCode || "").slice(0, 40),
    complaint: String(payload.complaint || "").slice(0, 1800),
    photos: Array.isArray(payload.photos) ? payload.photos.slice(0, 3) : [],
  };
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
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY ontbreekt op de server.");
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
  const response = await fetch("https://api.openai.com/v1/responses", {
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
  return { ai: true, model, ...parseModelJson(outputText) };
}

async function handleDiagnose(req, res) {
  try {
    const payload = JSON.parse(await readBody(req));
    const input = cleanCase(payload);
    const advice = await createAdvice(input);
    json(res, 200, advice);
  } catch (error) {
    json(res, error.status || 500, {
      ai: false,
      error: error.message || "Diagnose mislukt.",
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
  if (req.method === "POST" && req.url === "/api/diagnose") {
    handleDiagnose(req, res);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  json(res, 405, { error: "Methode niet toegestaan." });
});

server.listen(port, () => {
  console.log("Werkplaats Assistent draait op http://127.0.0.1:" + port);
});
