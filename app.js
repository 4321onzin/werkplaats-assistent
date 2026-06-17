const RDW_VEHICLE_ENDPOINT = "https://opendata.rdw.nl/resource/m9d7-ebf2.json";
const RDW_FUEL_ENDPOINT = "https://opendata.rdw.nl/resource/8ys7-d773.json";

const state = {
  vehicle: null,
  photos: [],
};

const els = {
  plateForm: document.querySelector("#plateForm"),
  plateInput: document.querySelector("#plateInput"),
  vehicleCard: document.querySelector("#vehicleCard"),
  vehicleName: document.querySelector("#vehicleName"),
  vehicleYear: document.querySelector("#vehicleYear"),
  vehicleFuel: document.querySelector("#vehicleFuel"),
  vehicleApk: document.querySelector("#vehicleApk"),
  vehicleMass: document.querySelector("#vehicleMass"),
  mileageInput: document.querySelector("#mileageInput"),
  faultInput: document.querySelector("#faultInput"),
  complaintInput: document.querySelector("#complaintInput"),
  photoInput: document.querySelector("#photoInput"),
  photoPreview: document.querySelector("#photoPreview"),
  diagnoseButton: document.querySelector("#diagnoseButton"),
  diagnoseOutput: document.querySelector("#diagnoseOutput"),
  clearButton: document.querySelector("#clearButton"),
  installState: document.querySelector("#installState"),
};

function cleanPlate(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatDate(raw) {
  if (!raw || raw.length !== 8) return "-";
  return `${raw.slice(6, 8)}-${raw.slice(4, 6)}-${raw.slice(0, 4)}`;
}

function yearFromDate(raw) {
  if (!raw || raw.length < 4) return "-";
  return raw.slice(0, 4);
}

function fuelLabel(vehicle) {
  if (!vehicle.brandstoffen?.length) return "-";
  return vehicle.brandstoffen.map((fuel) => fuel.brandstof_omschrijving).filter(Boolean).join(" + ") || "-";
}

async function lookupPlate(plate) {
  const vehicleUrl = new URL(RDW_VEHICLE_ENDPOINT);
  vehicleUrl.searchParams.set("kenteken", plate);

  const fuelUrl = new URL(RDW_FUEL_ENDPOINT);
  fuelUrl.searchParams.set("kenteken", plate);

  const [vehicleResponse, fuelResponse] = await Promise.all([fetch(vehicleUrl), fetch(fuelUrl)]);
  if (!vehicleResponse.ok) {
    throw new Error("RDW gaf geen bruikbaar antwoord.");
  }

  const rows = await vehicleResponse.json();
  if (!rows.length) {
    throw new Error("Geen voertuig gevonden voor dit kenteken.");
  }

  const fuelRows = fuelResponse.ok ? await fuelResponse.json() : [];
  return { ...rows[0], brandstoffen: fuelRows };
}

function renderVehicle(vehicle) {
  const make = vehicle.merk || "Onbekend merk";
  const model = vehicle.handelsbenaming || "onbekend model";

  els.vehicleName.textContent = `${make} ${model}`;
  els.vehicleYear.textContent = yearFromDate(vehicle.datum_eerste_toelating);
  els.vehicleFuel.textContent = fuelLabel(vehicle);
  els.vehicleApk.textContent = formatDate(vehicle.vervaldatum_apk);
  els.vehicleMass.textContent = vehicle.massa_ledig_voertuig ? `${vehicle.massa_ledig_voertuig} kg` : "-";
  els.vehicleCard.hidden = false;
}

function renderPhotos(files) {
  state.photos.forEach((item) => URL.revokeObjectURL(item.url));
  state.photos = Array.from(files).slice(0, 6).map((file) => ({
    name: file.name,
    url: URL.createObjectURL(file),
  }));

  els.photoPreview.innerHTML = "";
  for (const photo of state.photos) {
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.name || "Werkplaatsfoto";
    els.photoPreview.append(img);
  }
}

function buildChecklist() {
  const vehicleText = state.vehicle
    ? `${state.vehicle.merk || ""} ${state.vehicle.handelsbenaming || ""}`.trim()
    : "voertuig";
  const complaint = els.complaintInput.value.trim();
  const fault = els.faultInput.value.trim().toUpperCase();
  const mileage = els.mileageInput.value.trim();

  const checks = [
    "Begin met visuele inspectie: lekkage, losse stekkers, beschadigde slangen, zekeringen en accupolen.",
    "Controleer onderhoudshistorie en vloeistofniveaus voordat onderdelen worden vervangen.",
    "Maak een korte proefrit of stationaire test om de klacht reproduceerbaar te maken.",
  ];

  if (fault) {
    checks.unshift(`Lees alle foutcodes opnieuw uit, noteer freeze-frame data en wis nog niets voordat de basiscontrole klaar is. Hoofdcode: ${fault}.`);
  }

  if (/rem|brake|tril|schud/i.test(complaint)) {
    checks.push("Controleer remschijven, blokken, geleidepennen, wiellagers en bandenslijtage per as.");
  }

  if (/motor|lamp|stotter|loopt|start|p0/i.test(`${complaint} ${fault}`)) {
    checks.push("Controleer ontsteking, luchtinlaat, vacuümlekkage, brandstofdruk en relevante sensordata live.");
  }

  if (/koel|temperatuur|warm|lekkage/i.test(complaint)) {
    checks.push("Druktest het koelsysteem en controleer thermostaat, ventilatoraansturing, dop en zichtbare sporen.");
  }

  if (state.photos.length) {
    checks.push("Gebruik de foto’s als bewijs in het dossier en vergelijk zichtbare slijtage met de klacht van de klant.");
  }

  const missing = [];
  if (!state.vehicle) missing.push("kenteken/RDW-gegevens");
  if (!complaint) missing.push("klachtomschrijving");
  if (!mileage) missing.push("kilometerstand");

  els.diagnoseOutput.innerHTML = `
    <div class="advice-block">
      <h3>Samenvatting</h3>
      <ul>
        <li>Voertuig: ${vehicleText}</li>
        <li>Kilometerstand: ${mileage || "nog niet ingevuld"}</li>
        <li>Foutcode: ${fault || "geen foutcode ingevuld"}</li>
        <li>Foto's: ${state.photos.length}</li>
      </ul>
    </div>
    <div class="advice-block">
      <h3>Controlevolgorde</h3>
      <ol>
        ${checks.map((item) => `<li>${item}</li>`).join("")}
      </ol>
    </div>
    <div class="advice-block warning">
      <h3>Let op</h3>
      <p>Dit is een eerste werkplaatschecklist, geen definitieve diagnose. Vervang pas onderdelen na meting of reproduceerbare controle.</p>
      ${missing.length ? `<p>Voor beter advies ontbreken nog: ${missing.join(", ")}.</p>` : ""}
    </div>
  `;
}

function resetCase() {
  state.vehicle = null;
  state.photos.forEach((item) => URL.revokeObjectURL(item.url));
  state.photos = [];
  els.plateInput.value = "";
  els.mileageInput.value = "";
  els.faultInput.value = "";
  els.complaintInput.value = "";
  els.photoInput.value = "";
  els.photoPreview.innerHTML = "";
  els.vehicleCard.hidden = true;
  els.diagnoseOutput.textContent =
    "Vul kenteken, klacht en eventueel foto’s in. De app maakt daarna een praktische controlevolgorde.";
}

els.plateInput.addEventListener("input", () => {
  els.plateInput.value = cleanPlate(els.plateInput.value);
});

els.plateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const plate = cleanPlate(els.plateInput.value);
  if (!plate) return;

  els.diagnoseOutput.textContent = "RDW-gegevens ophalen...";

  try {
    state.vehicle = await lookupPlate(plate);
    renderVehicle(state.vehicle);
    els.diagnoseOutput.textContent = "Voertuig gevonden. Vul de klacht aan en maak een checklist.";
  } catch (error) {
    state.vehicle = null;
    els.vehicleCard.hidden = true;
    els.diagnoseOutput.textContent = error.message;
  }
});

els.photoInput.addEventListener("change", (event) => {
  renderPhotos(event.target.files);
});

els.diagnoseButton.addEventListener("click", buildChecklist);
els.clearButton.addEventListener("click", resetCase);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      els.installState.textContent = "Online";
    });
  });
}

window.addEventListener("appinstalled", () => {
  els.installState.textContent = "Geinstalleerd";
});
