/* ============================================================
   FARMACORP · INVENTARIO PRO
   Lógica de aplicación — Supabase + html5-qrcode + Chart.js
   ============================================================ */

// ----------------------------------------------------------------
// 1. CONFIGURACIÓN SUPABASE — reemplaza antes de producción
// ----------------------------------------------------------------
const SUPABASE_URL = "https://cepbrsqebmpghbfvwjtb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TSpHDb4fmePBKrXwWn3Q1A_Q0xehq7H";

// Foto de evidencia (independiente del escáner de código de barras) se sube
// a Cloudinary como en tus otros proyectos Farmacorp. Reemplaza estos dos
// valores; mientras tengan el placeholder, la app queda en modo demo local
// (la foto se previsualiza pero no se sube a ningún servidor).
const CLOUDINARY_CLOUD_NAME = "TU_CLOUD_NAME";
const CLOUDINARY_UPLOAD_PRESET = "TU_UPLOAD_PRESET";

let supabaseClient = null;
let supabaseReady = false;
try {
  if (window.supabase && SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("TU-PROYECTO")) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supabaseReady = true;
  }
} catch (e) {
  console.warn("Supabase no inicializado (modo demo/mock):", e.message);
}

// ----------------------------------------------------------------
// 2. DATOS MOCK (fallback cuando no hay credenciales de Supabase reales)
// Se usan SOLO si supabaseReady === false, para poder probar la interfaz.
// ----------------------------------------------------------------
const MOCK_PRODUCTS = [
  { id: "m1", cod_alternato: "7791234560012", producto_codigo: "FC-10231", descripcion: "PARACETAMOL 500MG X 100 TAB", almacen: "B100", ubicacion: "CU-CT-ME-15-00-00", sucursal_dest: "CT-01", cantidad_actual: 480, nro_lote: "L-24081", fecha_caducidad: "2027-03-01" },
  { id: "m2", cod_alternato: "7791234560029", producto_codigo: "FC-10455", descripcion: "IBUPROFENO 400MG X 20 TAB", almacen: "A102", ubicacion: "CU-CT-ME-16-00-00", sucursal_dest: "CT-02", cantidad_actual: 210, nro_lote: "L-24102", fecha_caducidad: null },
  { id: "m3", cod_alternato: "7791234560067", producto_codigo: "FC-11290", descripcion: "GUANTES DE LÁTEX TALLA M CAJA X 100", almacen: "A102", ubicacion: "CU-CT-ME-19-00-00", sucursal_dest: "CT-02", cantidad_actual: 75, nro_lote: null, fecha_caducidad: null },
  { id: "m4", cod_alternato: "7791234560081", producto_codigo: "FC-11602", descripcion: "OMEPRAZOL 20MG X 14 CAP", almacen: "B100", ubicacion: "CU-CT-ME-15-02-00", sucursal_dest: "SLTDP", cantidad_actual: 180, nro_lote: "L-24063", fecha_caducidad: "2027-01-20" },
  { id: "m5", cod_alternato: "7791234560104", producto_codigo: "FC-90001", descripcion: "LECHE FÓRMULA INFANTIL ETAPA 1 800G", almacen: "A102", ubicacion: "CU-CT-ME-20-00-00", sucursal_dest: "CT-01", cantidad_actual: 64, nro_lote: "L-24091", fecha_caducidad: "2026-12-05" },
];
const MOCK_CUARENTENA = [
  { id: "q1", producto_id: "m3", cod_alternato: "7791234560067", descripcion: "GUANTES DE LÁTEX TALLA M CAJA X 100", estado: "ACTIVA", motivo: "Empaque húmedo reportado en recepción" },
];
const MOCK_USERS = [
  { id: "u1", username: "jchuarachi", nombre_completo: "J. Chuarachi", role: "operador" },
  { id: "u2", username: "mrivero_02", nombre_completo: "M. Rivero", role: "operador" },
  { id: "u3", username: "admin", nombre_completo: "Auditor General", role: "supervisor", _mockPassword: "admin123" },
];

// ----------------------------------------------------------------
// 3. ESTADO GLOBAL
// ----------------------------------------------------------------
let currentUser = null;        // { id, username, nombre_completo, role }
let selectedProduct = null;
let records = [];              // cache local de conteos_inventario (para render inmediato)
let currentFilter = "all";
let mockRecordCounter = 0;
let evidencePhotoFile = null;  // File seleccionado, pendiente de subir
let evidencePhotoPreviewUrl = null;
let selectedTipos = new Set(); // tipos de incidencia activos: DANO, CRUZADO, VENCIDO, FALTANTE
let vistaSupervisor = [];      // cache de inv_vista_supervisor (stock + conteo combinados)
let matrizSoloCuarentena = false;
let matrizSucursal = "all";
let pendingScannedCode = null; // código escaneado/buscado sin match, a la espera de creación rápida

const TABS_OPERADOR = [
  { id: "scan", label: "Registro", icon: "scan-line" },
  { id: "mine", label: "Mis Registros", icon: "history" },
];
const TABS_SUPERVISOR = [
  { id: "control", label: "Control", icon: "filter" },
  { id: "match", label: "Matriz", icon: "layers" },
  { id: "dash", label: "Dashboard", icon: "bar-chart-3" },
  { id: "live", label: "En Vivo", icon: "radio" },
  { id: "scan", label: "Escanear", icon: "scan-line" },
];

// ----------------------------------------------------------------
// 4. LOGIN
// ----------------------------------------------------------------
function switchLoginRole(role) {
  const isOp = role === "operador";
  document.getElementById("formLoginOperador").classList.toggle("hidden", !isOp);
  document.getElementById("formLoginSupervisor").classList.toggle("hidden", isOp);
  document.getElementById("btnRoleOp").classList.toggle("active", isOp);
  document.getElementById("btnRoleSup").classList.toggle("active", !isOp);
}

async function handleLoginOperador(e) {
  e.preventDefault();
  const username = document.getElementById("opUsername").value.trim();
  const errEl = document.getElementById("opLoginError");
  errEl.classList.add("hidden");

  const result = await verificarLogin(username, null);
  if (!result || !result.valido || result.role !== "operador") {
    errEl.classList.remove("hidden");
    return;
  }
  currentUser = { id: result.id, username: result.username, nombre_completo: result.nombre_completo || result.username, role: "operador", zona: "Recepción" };
  startSession();
}

async function handleLoginSupervisor(e) {
  e.preventDefault();
  const username = document.getElementById("supUsername").value.trim();
  const password = document.getElementById("supPassword").value;
  const errEl = document.getElementById("supLoginError");
  errEl.classList.add("hidden");

  const result = await verificarLogin(username, password);
  if (!result || !result.valido || result.role !== "supervisor") {
    errEl.classList.remove("hidden");
    return;
  }
  currentUser = { id: result.id, username: result.username, nombre_completo: result.nombre_completo || result.username, role: "supervisor", zona: "Todas" };
  startSession();
}

// Llama a la función RPC `inv_verificar_login` (SECURITY DEFINER) en Supabase.
// En modo mock, valida contra MOCK_USERS localmente.
async function verificarLogin(username, password) {
  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient.rpc("inv_verificar_login", {
        p_username: username,
        p_password: password,
      });
      if (error) throw error;
      return data && data[0] ? data[0] : null;
    } catch (e) {
      console.error("Error en inv_verificar_login:", e.message);
      showToast("Error de conexión con Supabase.", true);
      return null;
    }
  }
  // ---- modo mock ----
  const u = MOCK_USERS.find(x => x.username === username);
  if (!u) return null;
  const valido = u.role === "operador" ? true : (u._mockPassword === password);
  return { id: u.id, username: u.username, nombre_completo: u.nombre_completo, role: u.role, valido };
}

function logout() {
  currentUser = null;
  selectedProduct = null;
  removeBarcodePhoto();
  document.getElementById("loginModal").classList.remove("hidden");
  document.getElementById("opUsername").value = "";
  document.getElementById("supUsername").value = "";
  document.getElementById("supPassword").value = "";
}

function startSession() {
  document.getElementById("loginModal").classList.add("hidden");
  document.getElementById("activeUserLabel").textContent = currentUser.nombre_completo;
  document.getElementById("activeUserAvatar").textContent = currentUser.username.slice(0, 2).toUpperCase();

  const badge = document.getElementById("roleBadge");
  badge.textContent = currentUser.role.toUpperCase();
  badge.className = "badge px-2.5 py-1 rounded-md " + (currentUser.role === "supervisor" ? "bg-orange-50 text-orange-700" : "bg-brand-50 text-brand-700");

  renderNav();
  const firstTab = currentUser.role === "operador" ? "scan" : "control";
  setActiveTab(firstTab);
  loadRecordsFromSupabase();
  subscribeRealtime();
}

// ----------------------------------------------------------------
// 5. NAVEGACIÓN
// ----------------------------------------------------------------
function renderNav() {
  const tabs = currentUser.role === "operador" ? TABS_OPERADOR : TABS_SUPERVISOR;

  const desktop = document.getElementById("navDesktop");
  desktop.innerHTML = tabs.map(t => `
    <button data-tab="${t.id}" class="navbtn-d px-4 py-2 rounded-t-lg text-sm font-semibold flex items-center gap-2">
      <i data-lucide="${t.icon}" class="w-4 h-4"></i>${t.label}
    </button>`).join("");

  const mobileInner = document.getElementById("navMobileInner");
  mobileInner.className = `grid grid-cols-${tabs.length}`;
  mobileInner.innerHTML = tabs.map(t => `
    <button data-tab="${t.id}" class="navbtn-m navitem py-2.5 flex flex-col items-center gap-1">
      <i data-lucide="${t.icon}" class="w-5 h-5"></i><span class="navlabel text-[10px] font-medium">${t.label}</span>
    </button>`).join("");

  document.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  lucide.createIcons();
}

function setActiveTab(tab) {
  document.querySelectorAll(".tabpanel").forEach(el => el.classList.add("hidden"));
  const panel = document.getElementById("tab-" + tab);
  if (panel) panel.classList.remove("hidden");

  document.querySelectorAll(".navbtn-m").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".navbtn-d").forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("bg-brand-50", active);
    b.classList.toggle("text-brand-700", active);
    b.classList.toggle("text-navy-400", !active);
  });

  if (tab === "dash") renderCharts();
  if (tab === "control") renderControlList();
  if (tab === "match") loadVistaSupervisor().then(renderMatchTable);
  if (tab === "mine") renderMyRecords();
  if (tab === "live") renderLiveFeed();
  if (tab === "scan") setTimeout(enfocarLectorFisico, 50);
  lucide.createIcons();
}

// ----------------------------------------------------------------
// 6. RELOJ
// ----------------------------------------------------------------
function tickClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("es-BO", { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ----------------------------------------------------------------
// 7. CATÁLOGO DE PRODUCTOS (Supabase o mock)
// ----------------------------------------------------------------
async function buscarProductos(query) {
  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient
        .from("inv_productos_maestro")
        .select("*")
        .or(`descripcion.ilike.%${query}%,producto_codigo.ilike.%${query}%,cod_alternato.ilike.%${query}%`)
        .limit(8);
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error("Error buscando productos:", e.message);
      return [];
    }
  }
  const q = query.toLowerCase();
  return MOCK_PRODUCTS.filter(p =>
    p.descripcion.toLowerCase().includes(q) ||
    (p.producto_codigo || "").toLowerCase().includes(q) ||
    (p.cod_alternato || "").includes(q)
  ).slice(0, 8);
}

// Cadena de búsqueda por código escaneado/tecleado:
//   1) columna principal cod_alternato en inv_productos_maestro
//   2) tabla inv_producto_codigos (códigos históricos, LPNs, alternos)
//   3) si nada matchea -> null (la UI ofrece crear el producto al vuelo)
async function buscarProductoPorBarcode(barcode) {
  const clean = barcode.trim();
  if (supabaseReady) {
    try {
      const { data: directo, error: errDirecto } = await supabaseClient
        .from("inv_productos_maestro")
        .select("*")
        .eq("cod_alternato", clean)
        .maybeSingle();
      if (errDirecto) throw errDirecto;
      if (directo) return directo;

      const { data: codigoAlterno, error: errAlterno } = await supabaseClient
        .from("inv_producto_codigos")
        .select("producto_id")
        .eq("codigo", clean)
        .maybeSingle();
      if (errAlterno) throw errAlterno;
      if (!codigoAlterno) return null;

      const { data: producto } = await supabaseClient
        .from("inv_productos_maestro")
        .select("*")
        .eq("id", codigoAlterno.producto_id)
        .maybeSingle();
      return producto || null;
    } catch (e) {
      console.error("Error buscando por código:", e.message);
      return null;
    }
  }
  return MOCK_PRODUCTS.find(p => p.cod_alternato === clean) || null;
}

// ----------------------------------------------------------------
// 8. BÚSQUEDA PREDICTIVA
// ----------------------------------------------------------------
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.addEventListener("input", async () => {
  const q = searchInput.value.trim();
  if (!q) { searchResults.classList.add("hidden"); return; }

  const matches = await buscarProductos(q);
  if (matches.length === 0) {
    searchResults.innerHTML = `
      <div class="p-4 text-center space-y-2">
        <p class="text-xs text-navy-300">Sin coincidencias en el maestro de productos</p>
        <button onclick='abrirCreacionRapida("${q.replace(/'/g, "\\'")}")' class="text-xs font-semibold text-brand-600 hover:underline">+ Crear "${q}" como producto nuevo</button>
      </div>`;
  } else {
    searchResults.innerHTML = matches.map(p => `
      <button onclick='selectProductById("${p.id}")' class="w-full text-left px-4 py-3 hover:bg-navy-50 flex items-center justify-between gap-2 border-b border-[#F1F5FB] last:border-0">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-navy-800 truncate">${p.descripcion}</p>
          <p class="text-[11px] text-navy-400 font-mono">${p.producto_codigo || "s/SKU"} · ${p.cod_alternato || "s/código"}</p>
        </div>
        <span class="badge px-2 py-1 rounded-md ${p.almacen === "B100" ? "bg-brand-50 text-brand-700" : "bg-navy-50 text-navy-500"}">${p.almacen || "—"}</span>
      </button>`).join("");
  }
  searchResults.classList.remove("hidden");
  window._lastSearchMatches = matches;
});

document.addEventListener("click", (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.classList.add("hidden");
});

function selectProductById(id) {
  const p = (window._lastSearchMatches || []).find(x => String(x.id) === String(id));
  if (!p) return;
  selectProduct(p);
  searchResults.classList.add("hidden");
  searchInput.value = "";
}

// ----------------------------------------------------------------
// 9. FOTO DEL CÓDIGO DE BARRAS (Html5Qrcode.scanFile — decodifica una
// imagen estática en vez de video en vivo: usa el enfoque automático de la
// cámara nativa del celular, más confiable que un stream de video en la web)
// ----------------------------------------------------------------
const BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.ITF,
];

let photoScannerInstance = null;
let barcodePhotoPreviewUrl = null;

function getPhotoScanner() {
  if (!photoScannerInstance) {
    photoScannerInstance = new Html5Qrcode("photoReader", { formatsToSupport: BARCODE_FORMATS, verbose: false });
  }
  return photoScannerInstance;
}

async function handleBarcodePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (barcodePhotoPreviewUrl) URL.revokeObjectURL(barcodePhotoPreviewUrl);
  barcodePhotoPreviewUrl = URL.createObjectURL(file);
  document.getElementById("barcodePhotoPreview").src = barcodePhotoPreviewUrl;
  document.getElementById("barcodePhotoPlaceholder").classList.add("hidden");
  document.getElementById("barcodePhotoPreviewWrap").classList.remove("hidden");

  const badge = document.getElementById("photoScanStatusBadge");
  badge.textContent = "LEYENDO…";
  badge.className = "badge px-2 py-1 rounded-md bg-orange-50 text-orange-700";

  try {
    const decodedText = await getPhotoScanner().scanFile(file, false);
    badge.textContent = "DETECTADO";
    badge.className = "badge px-2 py-1 rounded-md bg-ok-50 text-ok-500";
    await procesarCodigoDetectado(decodedText);
  } catch (err) {
    console.warn("No se pudo leer un código en la foto:", err);
    badge.textContent = "SIN DETECTAR";
    badge.className = "badge px-2 py-1 rounded-md bg-bad-50 text-bad-500";
    showToast("No se detectó ningún código en la foto. Prueba con más luz, más de cerca y sin reflejos.", true);
  } finally {
    event.target.value = ""; // permite volver a elegir el mismo archivo si hace falta
  }
}

function removeBarcodePhoto() {
  if (barcodePhotoPreviewUrl) URL.revokeObjectURL(barcodePhotoPreviewUrl);
  barcodePhotoPreviewUrl = null;
  document.getElementById("barcodePhotoInput").value = "";
  document.getElementById("barcodeGalleryInput").value = "";
  document.getElementById("barcodePhotoPreviewWrap").classList.add("hidden");
  document.getElementById("barcodePhotoPlaceholder").classList.remove("hidden");
  const badge = document.getElementById("photoScanStatusBadge");
  badge.textContent = "EN ESPERA";
  badge.className = "badge px-2 py-1 rounded-md bg-navy-50 text-navy-500";
}

// Lógica compartida: procesa cualquier código leído, venga de la foto, del
// lector físico USB/Bluetooth, o de la búsqueda manual. Busca match; si no
// hay, ofrece crear el producto al vuelo.
async function procesarCodigoDetectado(decodedText) {
  const p = await buscarProductoPorBarcode(decodedText);
  if (p) {
    selectProduct(p);
    showToast(`Producto detectado: ${p.descripcion}`);
  } else {
    showToast(`Código leído (${decodedText.slice(0, 13)}…) sin match en el maestro`, true);
    abrirCreacionRapida(decodedText);
  }
}

// ----------------------------------------------------------------
// 9c. LECTOR FÍSICO (USB / Bluetooth) — actúa como teclado: "escribe" el
// código y presiona Enter solo. No necesita cámara ni permisos.
// ----------------------------------------------------------------
const physicalScannerInput = document.getElementById("physicalScannerInput");

physicalScannerInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const codigo = physicalScannerInput.value.trim();
  physicalScannerInput.value = "";
  if (!codigo) return;
  await procesarCodigoDetectado(codigo);
  physicalScannerInput.focus();
});

function enfocarLectorFisico() {
  // Solo tiene sentido en desktop/tablet con lector conectado; en el
  // celular no molesta, simplemente no hay teclado físico que lo dispare.
  const loginVisible = !document.getElementById("loginModal").classList.contains("hidden");
  if (physicalScannerInput && !loginVisible) {
    physicalScannerInput.focus({ preventScroll: true });
  }
}

// ----------------------------------------------------------------
// 9b. CREACIÓN RÁPIDA DE PRODUCTO (código escaneado o buscado sin match)
// ----------------------------------------------------------------
function abrirCreacionRapida(codigo) {
  pendingScannedCode = codigo;
  document.getElementById("quickCreateCode").value = codigo;
  document.getElementById("quickCreateDescripcion").value = "";
  document.getElementById("quickCreateUbicacion").value = "";
  document.getElementById("quickCreateDuplicateWarning").classList.add("hidden");
  document.getElementById("quickCreatePanel").classList.remove("hidden");
  document.getElementById("quickCreatePanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  verificarDuplicados(codigo, null);
}

function cerrarCreacionRapida() {
  pendingScannedCode = null;
  document.getElementById("quickCreatePanel").classList.add("hidden");
}

// "Truco de lógica" pedido: antes de crear, revisa si algo parecido ya existe
// en Stock, Catálogo o Cuarentena — para no duplicar el mismo producto físico
// bajo identidades distintas.
let _dupCheckTimer = null;
document.getElementById("quickCreateDescripcion").addEventListener("input", (e) => {
  clearTimeout(_dupCheckTimer);
  const texto = e.target.value.trim();
  _dupCheckTimer = setTimeout(() => verificarDuplicados(pendingScannedCode, texto), 400);
});

async function verificarDuplicados(codigo, descripcion) {
  const warnEl = document.getElementById("quickCreateDuplicateWarning");
  let resultados = [];

  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient.rpc("inv_buscar_posibles_duplicados", {
        p_codigo: codigo || null,
        p_descripcion: descripcion && descripcion.length > 3 ? descripcion : null,
      });
      if (error) throw error;
      resultados = data || [];
    } catch (e) {
      console.error("Error verificando duplicados:", e.message);
      return;
    }
  } else {
    // ---- modo mock ----
    const q = (descripcion || "").toLowerCase();
    resultados = [
      ...MOCK_PRODUCTS.filter(p => (codigo && p.cod_alternato === codigo) || (q.length > 3 && p.descripcion.toLowerCase().includes(q)))
        .map(p => ({ fuente: "STOCK", cod_alternato: p.cod_alternato, descripcion: p.descripcion, sucursal_dest: p.sucursal_dest, estado: null })),
      ...MOCK_CUARENTENA.filter(c => (codigo && c.cod_alternato === codigo) || (q.length > 3 && c.descripcion.toLowerCase().includes(q)))
        .map(c => ({ fuente: "CUARENTENA", cod_alternato: c.cod_alternato, descripcion: c.descripcion, sucursal_dest: null, estado: c.estado })),
    ];
  }

  if (resultados.length === 0) {
    warnEl.classList.add("hidden");
    warnEl.innerHTML = "";
    return;
  }

  warnEl.classList.remove("hidden");
  warnEl.innerHTML = `
    <p class="text-xs font-bold text-orange-700 flex items-center gap-1.5"><i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>Posible duplicado — ya existe algo similar:</p>
    ${resultados.map(r => `
      <div class="text-xs bg-white/70 rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <span class="badge px-1.5 py-0.5 rounded bg-navy-900 text-white mr-1.5">${r.fuente}</span>
          <span class="font-semibold text-navy-800">${r.descripcion || "—"}</span>
          <span class="text-navy-400 font-mono"> · ${r.cod_alternato || "s/código"}</span>
        </div>
        ${r.sucursal_dest ? `<span class="text-navy-400 shrink-0">${r.sucursal_dest}</span>` : ""}
      </div>`).join("")}
    <p class="text-[10px] text-navy-500">Si es el mismo producto, usa la Búsqueda Manual de arriba en vez de crear uno nuevo. Si es distinto, puedes continuar.</p>
  `;
  lucide.createIcons();
}

async function crearProductoRapido() {
  const descripcion = document.getElementById("quickCreateDescripcion").value.trim();
  const ubicacion = document.getElementById("quickCreateUbicacion").value.trim();
  const almacen = document.getElementById("quickCreateAlmacen").value;
  if (!descripcion) { showToast("Escribe una descripción para el producto", true); return; }

  const payload = {
    cod_alternato: pendingScannedCode || null,
    descripcion,
    almacen,
    ubicacion: ubicacion || null,
    cantidad_actual: 0,
    creado_manual: true,
  };

  let nuevo = null;
  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient.from("inv_productos_maestro").insert([payload]).select();
      if (error) throw error;
      nuevo = data && data[0];
    } catch (e) {
      console.error("Error creando producto rápido:", e.message);
      showToast("No se pudo crear el producto. Intenta de nuevo.", true);
      return;
    }
  } else {
    nuevo = { id: "MOCKP" + Date.now(), ...payload };
    MOCK_PRODUCTS.push(nuevo);
  }

  showToast("Producto creado y seleccionado");
  cerrarCreacionRapida();
  selectProduct(nuevo);
}

// ----------------------------------------------------------------
// 10. FORMULARIO DE CONTEO
// ----------------------------------------------------------------
function selectProduct(p) {
  selectedProduct = p;
  document.getElementById("pName").textContent = p.descripcion;
  document.getElementById("pCode").textContent = p.producto_codigo || "—";
  document.getElementById("pBarcode").textContent = p.cod_alternato || "—";
  document.getElementById("pTheoretical").textContent = (p.cantidad_actual ?? 0) + " und.";
  const originBadge = document.getElementById("pOrigin");
  originBadge.textContent = p.almacen || "—";
  originBadge.className = "badge px-2 py-1 rounded-md shrink-0 " + (p.almacen === "B100" ? "bg-brand-50 text-brand-700" : "bg-navy-50 text-navy-500");

  document.getElementById("productCard").classList.remove("hidden");
  document.getElementById("noProductNotice").classList.add("hidden");
  document.getElementById("formBody").classList.remove("hidden");
  cerrarCreacionRapida();
  document.getElementById("productForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
  lucide.createIcons();
}

function clearSelection() {
  selectedProduct = null;
  document.getElementById("productCard").classList.add("hidden");
  document.getElementById("noProductNotice").classList.remove("hidden");
  document.getElementById("formBody").classList.add("hidden");
  resetForm();
  setTimeout(enfocarLectorFisico, 50);
}

function resetForm() {
  document.getElementById("qtyTotal").value = "";
  document.getElementById("qtyDamage").value = "";
  document.getElementById("qtyCrossed").value = "";
  document.getElementById("comment").value = "";
  document.getElementById("damageDescription").value = "";
  document.getElementById("lotNumber").value = "";
  document.getElementById("location").value = "";
  document.getElementById("expiryDate").value = "";
  document.getElementById("damageError").classList.add("hidden");
  document.getElementById("qtyGoodValue").textContent = "0";
  document.getElementById("expiryWrap").classList.add("hidden");
  selectedTipos.clear();
  document.querySelectorAll(".tipo-chip").forEach(c => c.classList.remove("active"));
  removeEvidencePhoto();
}

// ----------------------------------------------------------------
// 10b. TIPO DE INCIDENCIA (chips multi-selección)
// ----------------------------------------------------------------
document.querySelectorAll(".tipo-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const tipo = chip.dataset.tipo;
    if (selectedTipos.has(tipo)) selectedTipos.delete(tipo);
    else selectedTipos.add(tipo);
    chip.classList.toggle("active");
    document.getElementById("expiryWrap").classList.toggle("hidden", !selectedTipos.has("VENCIDO"));
  });
});

// ----------------------------------------------------------------
// 10c. FOTO DE EVIDENCIA (uso de cámara distinto al escáner: documenta el daño)
// ----------------------------------------------------------------
function handleEvidencePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  evidencePhotoFile = file;
  evidencePhotoPreviewUrl = URL.createObjectURL(file);
  document.getElementById("evidencePreview").src = evidencePhotoPreviewUrl;
  document.getElementById("evidenceEmpty").classList.add("hidden");
  document.getElementById("evidencePreviewWrap").classList.remove("hidden");
  lucide.createIcons();
}

function removeEvidencePhoto() {
  evidencePhotoFile = null;
  if (evidencePhotoPreviewUrl) URL.revokeObjectURL(evidencePhotoPreviewUrl);
  evidencePhotoPreviewUrl = null;
  document.getElementById("evidencePhotoInput").value = "";
  document.getElementById("evidenceEmpty").classList.remove("hidden");
  document.getElementById("evidencePreviewWrap").classList.add("hidden");
}

// Sube la foto a Cloudinary (unsigned upload). En modo demo (sin credenciales
// reales) solo devuelve la URL local de previsualización.
async function subirFotoEvidencia(file) {
  if (!file) return null;
  if (CLOUDINARY_CLOUD_NAME.includes("TU_CLOUD_NAME")) {
    return evidencePhotoPreviewUrl; // modo demo
  }
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: "POST", body: formData,
    });
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Respuesta sin secure_url");
    return data.secure_url;
  } catch (e) {
    console.error("Error subiendo foto a Cloudinary:", e.message);
    showToast("No se pudo subir la foto, el conteo se guardará sin evidencia.", true);
    return null;
  }
}

["qtyTotal", "qtyDamage", "qtyCrossed"].forEach(id => {
  document.getElementById(id).addEventListener("input", validateQuantities);
});

// Dañado + Cruzado no puede superar el Total. El resto se calcula como "buen estado".
function validateQuantities() {
  const total = parseInt(document.getElementById("qtyTotal").value) || 0;
  const dmg = parseInt(document.getElementById("qtyDamage").value) || 0;
  const crz = parseInt(document.getElementById("qtyCrossed").value) || 0;
  const err = document.getElementById("damageError");
  const invalid = (dmg + crz) > total;
  err.classList.toggle("hidden", !invalid);
  document.getElementById("qtyGoodValue").textContent = Math.max(0, total - dmg - crz);
  return !invalid;
}

async function registerCount() {
  if (!selectedProduct) { showToast("Selecciona un producto primero", true); return; }
  const total = parseInt(document.getElementById("qtyTotal").value);
  if (!total && total !== 0) { showToast("Ingresa la cantidad total contada", true); return; }
  if (!validateQuantities()) { showToast("Dañado + Cruzado no puede superar el total", true); return; }

  const damage = parseInt(document.getElementById("qtyDamage").value) || 0;
  const crossed = parseInt(document.getElementById("qtyCrossed").value) || 0;
  const expired = selectedTipos.has("VENCIDO");
  const expiryDate = document.getElementById("expiryDate").value || null;
  const lotNumber = document.getElementById("lotNumber").value.trim() || null;
  const location = document.getElementById("location").value.trim() || null;
  const damageDescription = document.getElementById("damageDescription").value.trim() || null;
  const comment = document.getElementById("comment").value.trim();

  const btn = document.getElementById("btnRegister");
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;

  let photoUrl = null;
  if (evidencePhotoFile) {
    btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Subiendo foto…';
    lucide.createIcons();
    photoUrl = await subirFotoEvidencia(evidencePhotoFile);
  }

  const payload = {
    producto_id: selectedProduct.id,
    usuario_nombre: currentUser.username,
    almacen: selectedProduct.almacen,
    zona: currentUser.zona || selectedProduct.almacen || null,
    cantidad_total: total,
    cantidad_danada: damage,
    cantidad_cruzada: crossed,
    cantidad_teorica_snapshot: selectedProduct.cantidad_actual ?? 0,
    es_vencido: expired,
    fecha_vencimiento: expiryDate,
    tipos_incidencia: Array.from(selectedTipos),
    descripcion_dano: damageDescription,
    foto_evidencia_url: photoUrl,
    lote: lotNumber,
    ubicacion: location,
    observaciones: comment,
  };

  btn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Guardando…';
  lucide.createIcons();
  const saved = await guardarConteo(payload);

  btn.disabled = false;
  btn.innerHTML = originalBtnHtml;
  lucide.createIcons();

  if (!saved) { showToast("No se pudo guardar el conteo. Intenta de nuevo.", true); return; }

  records.unshift(saved);
  showToast("Conteo registrado correctamente");
  renderMyRecords();
  clearSelection();
}

// Inserta en Supabase y confirma con .select() (patrón usado en tus otros
// proyectos para no depender de un insert "silencioso" bloqueado por RLS).
async function guardarConteo(payload) {
  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient
        .from("inv_conteos_inventario")
        .insert([payload])
        .select();
      if (error) throw error;
      if (!data || data.length === 0) {
        console.warn("Insert sin filas devueltas: revisa políticas RLS de conteos_inventario.");
        return null;
      }
      return normalizeRecord(data[0]);
    } catch (e) {
      console.error("Error guardando conteo:", e.message);
      return null;
    }
  }
  // ---- modo mock ----
  mockRecordCounter++;
  const mockRow = {
    id: "MOCK" + mockRecordCounter,
    created_at: new Date().toISOString(),
    cantidad_buena: payload.cantidad_total - payload.cantidad_danada - payload.cantidad_cruzada,
    ...payload,
  };
  return normalizeRecord(mockRow, selectedProduct);
}

// Homogeniza una fila cruda de conteos_inventario + su producto asociado
// en un objeto de conveniencia para el render.
function normalizeRecord(row, productoHint) {
  const producto = productoHint ||
    MOCK_PRODUCTS.find(p => p.id === row.producto_id) ||
    { descripcion: "—", producto_codigo: "—", almacen: row.almacen, cantidad_actual: row.cantidad_teorica_snapshot };
  return { ...row, producto };
}

// ----------------------------------------------------------------
// 11. CARGA INICIAL + REALTIME
// ----------------------------------------------------------------
async function loadRecordsFromSupabase() {
  if (!supabaseReady) return;
  try {
    const { data, error } = await supabaseClient
      .from("inv_conteos_inventario")
      .select("*, inv_productos_maestro(*)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    records = (data || []).map(r => normalizeRecord({ ...r, producto_id: r.producto_id }, r.inv_productos_maestro));
    refreshCurrentTab();
  } catch (e) {
    console.error("Error cargando inv_conteos_inventario:", e.message);
  }
}

// Trae inv_vista_supervisor (stock + último conteo combinados). En modo demo
// se arma el equivalente localmente cruzando MOCK_PRODUCTS + records + MOCK_CUARENTENA.
async function loadVistaSupervisor() {
  if (supabaseReady) {
    try {
      const { data, error } = await supabaseClient
        .from("inv_vista_supervisor")
        .select("*")
        .order("descripcion", { ascending: true });
      if (error) throw error;
      vistaSupervisor = data || [];
    } catch (e) {
      console.error("Error cargando inv_vista_supervisor:", e.message);
      vistaSupervisor = [];
    }
    return;
  }
  // ---- modo mock ----
  vistaSupervisor = MOCK_PRODUCTS.map(p => {
    const conteosProducto = records.filter(r => r.producto_id === p.id);
    const ultimo = conteosProducto[0] || null;
    const enCuarentena = MOCK_CUARENTENA.some(q => q.producto_id === p.id && q.estado === "ACTIVA");
    const diferencia = ultimo ? ultimo.cantidad_total - p.cantidad_actual : null;
    return {
      producto_id: p.id,
      cod_alternato: p.cod_alternato,
      producto_codigo: p.producto_codigo,
      descripcion: p.descripcion,
      almacen: p.almacen,
      ubicacion: p.ubicacion,
      sucursal_dest: p.sucursal_dest,
      cantidad_teorica: p.cantidad_actual,
      lote_wms: p.nro_lote,
      fecha_caducidad: p.fecha_caducidad,
      en_cuarentena: enCuarentena,
      responsable: ultimo?.usuario_nombre || null,
      cantidad_registrada: ultimo?.cantidad_total ?? null,
      cantidad_danada: ultimo?.cantidad_danada ?? null,
      cantidad_cruzada: ultimo?.cantidad_cruzada ?? null,
      observaciones: ultimo?.observaciones || null,
      fecha_conteo: ultimo?.created_at || null,
      estado_conteo: ultimo ? "CONTADO" : "PENDIENTE",
      diferencia,
      diferencia_tipo: diferencia === null ? null : diferencia > 0 ? "POSITIVO" : diferencia < 0 ? "NEGATIVO" : "NEUTRO",
    };
  });
}

let realtimeChannel = null;
function subscribeRealtime() {
  if (!supabaseReady || realtimeChannel) {
    document.getElementById("connLabel").textContent = supabaseReady
      ? "Conectado a Supabase Realtime"
      : "Modo demo (sin credenciales Supabase) — datos en memoria";
    return;
  }
  realtimeChannel = supabaseClient
    .channel("conteos_inventario_live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "inv_conteos_inventario" }, async (payload) => {
      const producto = await buscarProductoPorId(payload.new.producto_id);
      records.unshift(normalizeRecord(payload.new, producto));
      refreshCurrentTab();
    })
    .subscribe((status) => {
      document.getElementById("connLabel").textContent =
        status === "SUBSCRIBED" ? "Conectado a Supabase Realtime" : "Conectando a Supabase…";
    });
}

async function buscarProductoPorId(id) {
  if (!supabaseReady) return MOCK_PRODUCTS.find(p => p.id === id) || null;
  try {
    const { data } = await supabaseClient.from("inv_productos_maestro").select("*").eq("id", id).maybeSingle();
    return data || null;
  } catch { return null; }
}

function refreshCurrentTab() {
  const visible = document.querySelector(".tabpanel:not(.hidden)");
  if (!visible) return;
  const tab = visible.id.replace("tab-", "");
  if (tab === "live") renderLiveFeed();
  if (tab === "control") renderControlList();
  if (tab === "match") loadVistaSupervisor().then(renderMatchTable);
  if (tab === "dash") renderCharts();
  if (tab === "mine") renderMyRecords();
}

// ----------------------------------------------------------------
// 12. TOAST
// ----------------------------------------------------------------
function showToast(msg, isError) {
  const t = document.getElementById("toast");
  document.getElementById("toastMsg").textContent = msg;
  document.getElementById("toastIconOk").classList.toggle("hidden", !!isError);
  document.getElementById("toastIconError").classList.toggle("hidden", !isError);
  t.classList.remove("opacity-0", "translate-y-2"); t.classList.add("opacity-100", "translate-y-0");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    t.classList.add("opacity-0", "translate-y-2"); t.classList.remove("opacity-100", "translate-y-0");
  }, 2800);
}

// ----------------------------------------------------------------
// 13. MIS REGISTROS (operador)
// ----------------------------------------------------------------
function renderMyRecords() {
  const tbody = document.getElementById("myRecordsBody");
  const mine = records.filter(r => r.usuario_nombre === currentUser.username);
  tbody.innerHTML = mine.map(r => `
    <tr class="hover:bg-navy-50">
      <td class="p-2.5 text-navy-400">${formatTime(r.created_at)}</td>
      <td class="p-2.5 text-brand-600">${r.producto.producto_codigo}</td>
      <td class="p-2.5 text-navy-800">${r.producto.descripcion}</td>
      <td class="p-2.5 font-bold text-navy-900">${r.cantidad_total}</td>
      <td class="p-2.5 font-bold ${r.cantidad_danada > 0 ? "text-bad-500" : "text-navy-300"}">${r.cantidad_danada}</td>
      <td class="p-2.5 font-bold ${r.cantidad_cruzada > 0 ? "text-orange-600" : "text-navy-300"}">${r.cantidad_cruzada}</td>
      <td class="p-2.5 text-navy-400 italic">${r.observaciones || "--"}</td>
    </tr>`).join("");
}

// ----------------------------------------------------------------
// 14. MONITOREO EN VIVO (supervisor)
// ----------------------------------------------------------------
function renderLiveFeed() {
  document.getElementById("liveCount").textContent = records.length;
  const empty = document.getElementById("liveEmpty");
  const list = document.getElementById("liveList");
  if (records.length === 0) { empty.classList.remove("hidden"); list.classList.add("hidden"); return; }
  empty.classList.add("hidden"); list.classList.remove("hidden");

  list.innerHTML = records.slice(0, 100).map(r => `
    <div class="py-3 flex items-center gap-3">
      <div class="text-[11px] font-mono text-navy-400 w-14 shrink-0">${formatTime(r.created_at)}</div>
      <div class="w-7 h-7 rounded-full bg-navy-50 flex items-center justify-center text-[10px] font-bold text-navy-600 font-mono shrink-0">${r.usuario_nombre.slice(0, 2).toUpperCase()}</div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-navy-800 truncate">${r.producto.descripcion}</p>
        <p class="text-[11px] text-navy-400 font-mono">${r.producto.producto_codigo}</p>
      </div>
      <span class="badge px-2 py-1 rounded-md shrink-0 ${r.almacen === "B100" ? "bg-brand-50 text-brand-700" : "bg-navy-50 text-navy-500"}">${r.almacen}</span>
      <div class="text-right shrink-0 w-14"><p class="text-sm font-bold text-navy-900 font-mono">${r.cantidad_total}</p></div>
      <div class="flex gap-1 shrink-0">
        ${r.cantidad_danada > 0 ? `<span class="badge px-1.5 py-1 rounded chip-danado" title="Dañado">DAÑ</span>` : ""}
        ${r.cantidad_cruzada > 0 ? `<span class="badge px-1.5 py-1 rounded chip-cruzado" title="Cruzado">CRZ</span>` : ""}
        ${r.es_vencido ? `<span class="badge px-1.5 py-1 rounded chip-vencido" title="Vencido">VNC</span>` : ""}
      </div>
    </div>`).join("");
}

// ----------------------------------------------------------------
// 15. CENTRO DE CONTROL (supervisor)
// ----------------------------------------------------------------
document.querySelectorAll(".filter-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderControlList();
  });
});

function renderControlList() {
  let filtered = records;
  if (currentFilter === "danado") filtered = records.filter(r => r.cantidad_danada > 0);
  if (currentFilter === "cruzado") filtered = records.filter(r => r.cantidad_cruzada > 0);
  if (currentFilter === "vencido") filtered = records.filter(r => r.es_vencido);
  if (currentFilter === "diff") filtered = records.filter(r => r.cantidad_total !== (r.producto.cantidad_actual ?? r.cantidad_teorica_snapshot ?? 0));

  const empty = document.getElementById("controlEmpty");
  const list = document.getElementById("controlList");
  if (filtered.length === 0) { empty.classList.remove("hidden"); list.classList.add("hidden"); return; }
  empty.classList.add("hidden"); list.classList.remove("hidden");

  list.innerHTML = filtered.map(r => {
    const teorico = r.producto.cantidad_actual ?? r.cantidad_teorica_snapshot ?? 0;
    const diff = r.cantidad_total - teorico;
    const diffLabel = diff === 0
      ? '<span class="text-navy-400">sin diferencia</span>'
      : diff > 0
        ? `<span class="text-ok-500 font-semibold">+${diff} sobrante</span>`
        : `<span class="text-bad-500 font-semibold">${diff} faltante</span>`;
    return `
    <div class="fc-card p-3.5">
      <div class="flex items-start gap-3">
        ${r.foto_evidencia_url ? `<img src="${r.foto_evidencia_url}" class="w-16 h-16 rounded-lg object-cover border border-[#E1EBF5] shrink-0" alt="Evidencia">` : ""}
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-navy-800 truncate">${r.producto.descripcion}</p>
              <p class="text-[11px] text-navy-400 font-mono mt-0.5">${r.producto.producto_codigo} · ${r.zona || ""}${r.ubicacion ? " · " + r.ubicacion : ""}</p>
            </div>
            <span class="badge px-2 py-1 rounded-md shrink-0 ${r.almacen === "B100" ? "bg-brand-50 text-brand-700" : "bg-navy-50 text-navy-500"}">${r.almacen}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
            <span class="text-navy-500">Contado: <b class="text-navy-800 font-mono">${r.cantidad_total}</b></span>
            <span class="text-navy-500">Teórico: <b class="text-navy-800 font-mono">${teorico}</b></span>
            <span class="text-navy-500">Dif: ${diffLabel}</span>
            ${r.lote ? `<span class="text-navy-500">Lote: <b class="text-navy-800 font-mono">${r.lote}</b></span>` : ""}
          </div>
        </div>
      </div>
      ${(r.cantidad_danada > 0 || r.cantidad_cruzada > 0 || r.es_vencido) ? `<div class="flex gap-1.5 mt-2.5">
        ${r.cantidad_danada > 0 ? `<span class="badge px-2 py-1 rounded-md chip-danado">DAÑADO ${r.cantidad_danada}</span>` : ""}
        ${r.cantidad_cruzada > 0 ? `<span class="badge px-2 py-1 rounded-md chip-cruzado">CRUZADO ${r.cantidad_cruzada}</span>` : ""}
        ${r.es_vencido ? `<span class="badge px-2 py-1 rounded-md chip-vencido">VENCIDO</span>` : ""}
      </div>` : ""}
      ${r.descripcion_dano ? `<p class="text-xs text-navy-600 mt-2 border-t border-[#F1F5FB] pt-2"><b>Daño:</b> ${r.descripcion_dano}</p>` : ""}
      ${r.observaciones ? `<p class="text-xs text-navy-400 italic mt-1">"${r.observaciones}"</p>` : ""}
    </div>`;
  }).join("");
}

// ----------------------------------------------------------------
// 16. MATRIZ = VISTA SUPERVISOR (stock + conteo combinados)
// Muestra inv_vista_supervisor completa, con filtro "solo cuarentena" y
// selector de sucursal (CT-01 / CT-02 / SLTDP / ...), armado dinámicamente
// a partir de los valores reales presentes en los datos.
// ----------------------------------------------------------------
function renderMatchTable() {
  // Selector de sucursal: opciones dinámicas según lo que haya en los datos
  const sucursales = Array.from(new Set(vistaSupervisor.map(r => r.sucursal_dest).filter(Boolean))).sort();
  const selectEl = document.getElementById("matrizSucursalSelect");
  if (selectEl) {
    const current = selectEl.value || "all";
    selectEl.innerHTML = `<option value="all">Todas las sucursales</option>` +
      sucursales.map(s => `<option value="${s}">${s}</option>`).join("");
    selectEl.value = sucursales.includes(current) ? current : "all";
    matrizSucursal = selectEl.value;
  }

  let filtered = vistaSupervisor;
  if (matrizSoloCuarentena) filtered = filtered.filter(r => r.en_cuarentena);
  if (matrizSucursal !== "all") filtered = filtered.filter(r => r.sucursal_dest === matrizSucursal);

  // KPIs de la matriz
  const total = filtered.length;
  const contados = filtered.filter(r => r.estado_conteo === "CONTADO").length;
  const pendientes = total - contados;
  const enCuarentena = filtered.filter(r => r.en_cuarentena).length;
  const kpiWrap = document.getElementById("matrizKpis");
  if (kpiWrap) {
    kpiWrap.innerHTML = `
      <div class="fc-card p-3"><p class="text-[10px] font-semibold text-navy-400 uppercase">Total Productos</p><p class="font-display font-800 text-lg text-navy-900">${total}</p></div>
      <div class="fc-card p-3"><p class="text-[10px] font-semibold text-navy-400 uppercase">Contados</p><p class="font-display font-800 text-lg text-ok-500">${contados}</p></div>
      <div class="fc-card p-3"><p class="text-[10px] font-semibold text-navy-400 uppercase">Pendientes</p><p class="font-display font-800 text-lg text-orange-500">${pendientes}</p></div>
      <div class="fc-card p-3"><p class="text-[10px] font-semibold text-navy-400 uppercase">En Cuarentena</p><p class="font-display font-800 text-lg text-bad-500">${enCuarentena}</p></div>`;
  }

  const tbody = document.getElementById("matchBody");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-navy-300 text-xs">Sin productos para este filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const diffLabel = r.diferencia === null
      ? '<span class="text-navy-300">—</span>'
      : r.diferencia_tipo === "NEUTRO"
        ? '<span class="text-navy-400">0</span>'
        : r.diferencia_tipo === "POSITIVO"
          ? `<span class="text-ok-500 font-bold">+${r.diferencia}</span>`
          : `<span class="text-bad-500 font-bold">${r.diferencia}</span>`;
    return `
    <tr class="hover:bg-navy-50">
      <td class="p-3"><div class="font-bold text-navy-800">${r.descripcion}</div><div class="text-[10px] text-brand-600">${r.producto_codigo || "s/SKU"} · ${r.cod_alternato || "s/código"}</div></td>
      <td class="p-3 text-center"><span class="badge px-2 py-0.5 rounded bg-navy-50 text-navy-500">${r.sucursal_dest || "—"}</span></td>
      <td class="p-3 text-navy-500">${r.ubicacion || "—"}</td>
      <td class="p-3 text-center font-bold text-navy-800">${r.cantidad_teorica ?? 0}</td>
      <td class="p-3 text-navy-600">${r.responsable || "—"}</td>
      <td class="p-3 text-center font-bold text-navy-800">${r.cantidad_registrada ?? "—"}</td>
      <td class="p-3 text-center">${diffLabel}</td>
      <td class="p-3 text-center"><span class="badge px-2 py-0.5 rounded ${r.estado_conteo === "CONTADO" ? "chip-ok" : "chip-cruzado"}">${r.estado_conteo}</span></td>
      <td class="p-3 text-center">${r.en_cuarentena ? '<span class="badge px-2 py-0.5 rounded chip-danado">CUARENTENA</span>' : '<span class="text-navy-300">—</span>'}</td>
      <td class="p-3 text-navy-500">${r.lote_wms || "—"}</td>
      <td class="p-3 text-navy-400 italic">${r.observaciones || "—"}</td>
    </tr>`;
  }).join("");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".matriz-filter-pill");
  if (!btn) return;
  document.querySelectorAll(".matriz-filter-pill").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  matrizSoloCuarentena = btn.dataset.cuarentena === "true";
  renderMatchTable();
});
document.addEventListener("change", (e) => {
  if (e.target.id !== "matrizSucursalSelect") return;
  matrizSucursal = e.target.value;
  renderMatchTable();
});

// ----------------------------------------------------------------
// 17. DASHBOARD / GRÁFICOS
// ----------------------------------------------------------------
let chartOrigin, chartDamageVsCrossed, chartTopDamage, chartUsers;

function computeKPIs() {
  const totalUnits = records.reduce((s, r) => s + r.cantidad_total, 0);
  const totalDamage = records.reduce((s, r) => s + r.cantidad_danada, 0);
  const totalCrossed = records.reduce((s, r) => s + r.cantidad_cruzada, 0);
  const effectiveness = totalUnits > 0 ? Math.max(0, Math.round(((totalUnits - totalDamage) / totalUnits) * 100)) : 100;

  document.getElementById("kpiTotal").textContent = totalUnits.toLocaleString("es-BO");
  document.getElementById("kpiDamage").textContent = totalDamage.toLocaleString("es-BO");
  document.getElementById("kpiCrossed").textContent = totalCrossed.toLocaleString("es-BO");
  document.getElementById("kpiEffectiveness").textContent = effectiveness + "%";
}

function renderCharts() {
  computeKPIs();

  // --- Distribución de origen (dinámico: agrupa por el valor real de "almacen") ---
  const byAlmacen = {};
  records.forEach(r => { byAlmacen[r.almacen || "Sin almacén"] = (byAlmacen[r.almacen || "Sin almacén"] || 0) + r.cantidad_total; });
  const almacenLabels = Object.keys(byAlmacen).length ? Object.keys(byAlmacen) : ["Sin datos aún"];
  const almacenValues = Object.keys(byAlmacen).length ? Object.values(byAlmacen) : [1];
  const palette = ["#157fc5", "#7AA6DD", "#f38324", "#0B3F73", "#fdd20a"];
  const ctx1 = document.getElementById("chartOrigin");
  if (chartOrigin) chartOrigin.destroy();
  chartOrigin = new Chart(ctx1, {
    type: "doughnut",
    data: { labels: almacenLabels, datasets: [{ data: almacenValues, backgroundColor: palette, borderWidth: 0 }] },
    options: { plugins: { legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, color: "#0B3F73", boxWidth: 10 } } }, cutout: "68%" }
  });

  // --- Merma real vs. cruzados recuperables ---
  const totalDamage = records.reduce((s, r) => s + r.cantidad_danada, 0);
  const totalCrossed = records.reduce((s, r) => s + r.cantidad_cruzada, 0);
  const ctx2 = document.getElementById("chartDamageVsCrossed");
  if (chartDamageVsCrossed) chartDamageVsCrossed.destroy();
  chartDamageVsCrossed = new Chart(ctx2, {
    type: "pie",
    data: { labels: ["Merma real (pérdida)", "Cruzado (recuperable)"], datasets: [{ data: [totalDamage || 0, totalCrossed || 0], backgroundColor: ["#E63946", "#f38324"], borderWidth: 0 }] },
    options: { plugins: { legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, color: "#0B3F73", boxWidth: 10 } } } }
  });

  // --- Top 5 daño físico ---
  const byProduct = {};
  records.forEach(r => { byProduct[r.producto.descripcion] = (byProduct[r.producto.descripcion] || 0) + r.cantidad_danada; });
  const top5 = Object.entries(byProduct).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const ctx3 = document.getElementById("chartTopDamage");
  if (chartTopDamage) chartTopDamage.destroy();
  chartTopDamage = new Chart(ctx3, {
    type: "bar",
    data: { labels: top5.length ? top5.map(x => x[0].slice(0, 22)) : ["Sin datos aún"], datasets: [{ data: top5.length ? top5.map(x => x[1]) : [0], backgroundColor: "#E63946", borderRadius: 6 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { grid: { color: "#F1F5FB" }, ticks: { color: "#7AA6DD", font: { size: 10 } } }, y: { grid: { display: false }, ticks: { color: "#0B3F73", font: { size: 10 } } } } }
  });

  // --- Conteo por operario ---
  const byUser = {};
  records.forEach(r => { byUser[r.usuario_nombre] = (byUser[r.usuario_nombre] || 0) + r.cantidad_total; });
  const users = Object.keys(byUser).length ? Object.keys(byUser) : ["Sin datos aún"];
  const values = Object.keys(byUser).length ? Object.values(byUser) : [0];
  const ctx4 = document.getElementById("chartUsers");
  if (chartUsers) chartUsers.destroy();
  chartUsers = new Chart(ctx4, {
    type: "bar",
    data: { labels: users, datasets: [{ data: values, backgroundColor: "#f38324", borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { grid: { color: "#F1F5FB" }, ticks: { color: "#7AA6DD", font: { size: 10 } } }, x: { grid: { display: false }, ticks: { color: "#0B3F73", font: { size: 10 } } } } }
  });
}

// ----------------------------------------------------------------
// 18. UTILIDADES
// ----------------------------------------------------------------
function formatTime(iso) {
  if (!iso) return "--";
  return new Date(iso).toLocaleTimeString("es-BO", { hour12: false }).slice(0, 5);
}

// ----------------------------------------------------------------
// 19. INIT
// ----------------------------------------------------------------
lucide.createIcons();
document.getElementById("loginModal").classList.remove("hidden");
if (!supabaseReady) {
  document.getElementById("connLabel").textContent = "Modo demo (sin credenciales Supabase) — datos en memoria";
}