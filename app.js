/**
 * ============================================================================
 * KOKON CARS & BIKE SERVICE — FRONTEND LOGIC (app.js)
 * ============================================================================
 * Plain JavaScript, no external UI libraries. Works as an SPA on top of
 * index.html, toggling visibility of <section class="screen"> elements and
 * filling them with data from the Google Apps Script API (Code.gs).
 *
 * FILE STRUCTURE:
 *   1. CONFIGURATION (all constants live here)
 *   2. I18N DICTIONARY + TRANSLATION HELPER
 *   3. APPLICATION STATE
 *   4. INITIALIZATION AND AUTHORIZATION
 *   5. API LAYER (fetch wrapper, error handling)
 *   6. SCREEN NAVIGATION
 *   7. DASHBOARD (stats + vehicle list)
 *   8. SEARCH AND FILTERING
 *   9. VEHICLE CARD
 *   10. UPDATE STATE (Editor form, incl. rental fields)
 *   11. INSPECTION
 *   12. RENTAL CALENDAR
 *   13. PHOTO HANDLING
 *   14. HELPERS (toast, formatting, status colors)
 * ============================================================================
 */

/* ============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

const APP_CONFIG = {
  // Apps Script web app URL (Deploy → New deployment → Web app).
  // REPLACE this with your actual deployed Apps Script URL before publishing.
  API_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',

  // Faults selectable when updating vehicle state
  FAULT_OPTIONS: [
    { id: 'oil', label: 'Oil', icon: '🛢️' },
    { id: 'brakes', label: 'Brakes', icon: '🛑' },
    { id: 'battery', label: 'Battery', icon: '🔋' },
    { id: 'tires', label: 'Tires', icon: '🛞' },
    { id: 'turn_signal', label: 'Turn signal', icon: '↩️' },
    { id: 'headlight', label: 'Headlight', icon: '💡' },
    { id: 'other', label: 'Other', icon: '⚠️' }
  ],

  // Max dimension (px) for photo compression before upload
  PHOTO_MAX_DIMENSION: 1280,
  PHOTO_JPEG_QUALITY: 0.75,

  // Toast display duration (ms)
  TOAST_DURATION: 2600,

  // Status values as stored in the Vehicles sheet (must match CONFIG.VEHICLE_STATUS in Code.gs)
  STATUS: {
    FREE: 'Free',
    RENTED: 'Rented',
    REPAIR: 'In Repair',
    NEEDS_REPAIR: 'Needs Repair'
  }
};


/* ============================================================================
 * 2. I18N DICTIONARY + TRANSLATION HELPER
 * ========================================================================== */

/**
 * I18N — dictionary of all user-facing strings. English is the only active
 * language today, but keeping every string in one place makes it simple to
 * add more languages later (just add another top-level key and switch
 * CURRENT_LANG).
 */
const I18N = {
  en: {
    'loading.checkingAccess': 'Checking access…',
    'noAccess.title': "You don't have access to this system",
    'noAccess.body': 'Please contact your Kokon Cars administrator to request access.',
    'error.title': "Couldn't load data",
    'error.body': 'Check your connection and try again.',
    'error.retry': 'Retry',

    'dashboard.rentalCalendar': 'Rental Calendar',
    'dashboard.startInspection': 'Start Inspection',
    'dashboard.searchPlaceholder': 'Search: brand, model, plate, VIN…',

    'filter.all': 'All statuses',
    'filter.overdue': 'Maintenance Overdue',
    'filter.dueSoon': 'Maintenance Due Soon',
    'filter.rentalEnding': 'Rental Ending Soon',

    'status.free': 'Free',
    'status.rented': 'Rented',
    'status.repair': 'In Repair',
    'status.needsRepair': 'Needs Repair',

    'card.updateState': 'Update State',
    'card.mileage': 'Mileage',
    'card.type': 'Type',
    'card.lastMaintenance': 'Last Maintenance',
    'card.nextMaintenance': 'Next Maintenance',
    'card.year': 'Year',
    'card.vin': 'VIN',
    'card.responsible': 'Responsible',
    'card.inspection': 'Last Inspection',
    'card.inspectionNone': 'not performed',
    'card.rentalPeriod': 'Rental Period',
    'card.rentalTenant': 'Tenant',
    'card.rentalDaysLeft': 'days left',
    'card.rentalExpired': 'Rental period has ended',
    'card.maintenanceHistory': 'Maintenance History',
    'card.damageHistory': 'Damage History',
    'card.inspectionHistory': 'Inspection History',
    'card.noRecords': 'No records yet',

    'updateForm.title': 'Update State',
    'updateForm.mileage': 'Current Mileage (km)',
    'updateForm.status': 'Vehicle Status',
    'updateForm.statusNoChange': "Don't change",
    'updateForm.rentalTenant': 'Tenant / Renter',
    'updateForm.rentalTenantPlaceholder': 'Name or company',
    'updateForm.rentalStart': 'Rental Start Date',
    'updateForm.rentalEnd': 'Rental End Date',
    'updateForm.comment': 'Notes / Comment',
    'updateForm.commentPlaceholder': 'Describe any notes…',
    'updateForm.faults': 'Faults',
    'updateForm.photos': 'Photos',
    'updateForm.save': 'Save',

    'inspection.title': 'Inspection',
    'inspectionForm.mileage': 'Mileage at Inspection (km)',
    'inspectionForm.notes': 'Notes',
    'inspectionForm.notesPlaceholder': 'Condition, damage, comments…',
    'inspectionForm.save': 'Confirm',

    'calendar.title': 'Rental Calendar',
    'calendar.noRentals': 'No active or scheduled rentals',
    'calendar.endingSoon': 'Ending soon',
    'calendar.expired': 'Rental ended',
    'calendar.active': 'Active',
    'calendar.upcoming': 'Upcoming',

    'toast.saved': 'Saved',
    'toast.stateUpdated': 'State updated',
    'toast.inspectionRecorded': 'Inspection recorded',
    'toast.noEditPermission': "You don't have edit permission",
    'toast.noInspectionPermission': "You don't have permission to run inspections",
    'toast.photoError': 'Could not process photo',
    'toast.connectionError': 'Connection error with the server',
    'toast.nothingFound': 'Nothing found'
  }
};

/** Active language. Only 'en' is populated today; kept as a variable so more
 * languages can be added to I18N and switched here without touching the rest
 * of the code. */
const CURRENT_LANG = 'en';

/**
 * t — looks up a translation key in the active language dictionary.
 * Falls back to the key itself if not found, so missing translations are
 * visible during development instead of silently breaking the UI.
 *
 * @param {string} key
 * @return {string}
 */
function t(key) {
  const dict = I18N[CURRENT_LANG] || I18N.en;
  return dict[key] !== undefined ? dict[key] : key;
}

/**
 * applyTranslations — walks the DOM once on startup and fills every element
 * carrying data-i18n / data-i18n-placeholder with the matching translation.
 * Called once after DOMContentLoaded, before any screen is shown.
 */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });
}


/* ============================================================================
 * 3. APPLICATION STATE
 * ========================================================================== */

const AppState = {
  telegramId: null,
  username: null,
  userName: null,
  role: null,        // 'Viewer' | 'Editor'
  canEdit: false,

  vehicles: [],       // full vehicle list cache (last getVehicles result)
  dashboardStats: null,
  rentalCalendarData: null,

  currentVehicleId: null,   // ID of the currently open card
  currentVehicleData: null, // full data of the open card (with histories)

  // Transient form state for update/inspection
  pendingPhotos: [],
  pendingFaults: [],
  pendingInspectionPhotos: [],

  // Inspection flow state (sequential walk-through of all vehicles)
  inspectionQueue: [],
  inspectionDoneIds: new Set(),
  inspectionCurrentVehicleId: null,

  // Rental calendar: which month is currently displayed
  calendarViewDate: new Date(),

  searchQuery: '',
  filterValue: 'all'
};


/* ============================================================================
 * 4. INITIALIZATION AND AUTHORIZATION
 * ========================================================================== */

/**
 * Application entry point. Runs after the DOM has loaded.
 */
document.addEventListener('DOMContentLoaded', function () {
  applyTranslations();
  initTelegramWebApp();
  bindGlobalEventListeners();
  authorizeAndStart();
});

/**
 * initTelegramWebApp — initializes the Telegram Web App SDK: tells Telegram
 * the app is ready, expands it to full height, and applies the Telegram
 * client's color theme.
 */
function initTelegramWebApp() {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    if (tg.themeParams) {
      const root = document.documentElement;
      if (tg.themeParams.bg_color) root.style.setProperty('--tg-theme-bg-color', tg.themeParams.bg_color);
      if (tg.themeParams.secondary_bg_color) root.style.setProperty('--tg-theme-secondary-bg-color', tg.themeParams.secondary_bg_color);
      if (tg.themeParams.text_color) root.style.setProperty('--tg-theme-text-color', tg.themeParams.text_color);
      if (tg.themeParams.hint_color) root.style.setProperty('--tg-theme-hint-color', tg.themeParams.hint_color);
      if (tg.themeParams.link_color) root.style.setProperty('--tg-theme-link-color', tg.themeParams.link_color);
      if (tg.themeParams.button_color) root.style.setProperty('--tg-theme-button-color', tg.themeParams.button_color);
      if (tg.themeParams.button_text_color) root.style.setProperty('--tg-theme-button-text-color', tg.themeParams.button_text_color);
    }
  }
}

/**
 * getTelegramUser — extracts Telegram user data from initDataUnsafe.
 * In production, real verification of initData's authenticity should happen
 * server-side (see the verifyTelegramAuth comment in Code.gs); here we only
 * read fields for display and to pass telegramId to the API.
 *
 * @return {Object|null} { id, username, firstName, lastName } or null
 */
function getTelegramUser() {
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe) {
    const user = window.Telegram.WebApp.initDataUnsafe.user;
    if (user) {
      return {
        id: String(user.id),
        username: user.username || '',
        firstName: user.first_name || '',
        lastName: user.last_name || ''
      };
    }
  }
  return null;
}

/**
 * authorizeAndStart — main startup flow: gets the Telegram ID, verifies it
 * through the API (action: 'authorize'), and shows either the Dashboard or
 * the "No access" screen depending on the result.
 */
async function authorizeAndStart() {
  showScreen('screen-loading');

  const telegramUser = getTelegramUser();

  if (!telegramUser) {
    // If opened outside Telegram (e.g. local debugging in a browser), still
    // attempt to proceed with an empty ID — the server will return "no access".
    showScreen('screen-no-access');
    return;
  }

  AppState.telegramId = telegramUser.id;
  AppState.username = telegramUser.username;

  try {
    const result = await callApi('authorize', {
      telegramId: telegramUser.id,
      username: telegramUser.username
    });

    if (!result.success) {
      showError(result.error || 'Authorization error');
      return;
    }

    if (!result.authorized) {
      showScreen('screen-no-access');
      return;
    }

    AppState.role = result.role;
    AppState.userName = result.name;
    AppState.canEdit = !!result.canEdit;

    applyRoleToUI();
    await loadDashboard();
    showScreen('screen-dashboard');

  } catch (err) {
    showError('Could not reach the server. Check your internet connection.');
  }
}

/**
 * applyRoleToUI — shows/hides UI elements available only to editors, based
 * on the current user's role. This is a UX layer only: real enforcement
 * always happens server-side.
 */
function applyRoleToUI() {
  const roleBadge = document.getElementById('user-role-badge');
  roleBadge.textContent = AppState.role === 'Editor' ? 'Editor' : 'Viewer';

  const editorOnlyElements = [
    document.getElementById('btn-start-inspection'),
    document.getElementById('btn-update-state')
  ];

  editorOnlyElements.forEach(function (el) {
    if (!el) return;
    if (AppState.canEdit) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}


/* ============================================================================
 * 5. API LAYER
 * ========================================================================== */

/**
 * callApi — generic wrapper over fetch() for calling Apps Script methods.
 * Sends a POST request with a JSON body { action, telegramId, data }.
 *
 * @param {string} action - action name (must match a case in Code.gs)
 * @param {Object} data - arbitrary request data
 * @return {Promise<Object>} parsed JSON server response
 */
async function callApi(action, data) {
  data = data || {};

  const body = {
    action: action,
    telegramId: data.telegramId || AppState.telegramId,
    data: data
  };

  const response = await fetch(APP_CONFIG.API_URL, {
    method: 'POST',
    headers: {
      // Using text/plain to avoid a CORS preflight request, which the
      // Apps Script Web App doesn't support out of the box.
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error('Server returned status ' + response.status);
  }

  const json = await response.json();
  return json;
}

/**
 * callApiSafe — wrapper over callApi that automatically shows a toast on
 * error. Used where a single action's failure shouldn't halt the whole
 * screen (e.g. saving a form).
 *
 * @param {string} action
 * @param {Object} data
 * @return {Promise<Object|null>} result, or null on error
 */
async function callApiSafe(action, data) {
  try {
    const result = await callApi(action, data);
    if (!result.success) {
      showToast(result.error || 'An error occurred', 'error');
      return null;
    }
    return result;
  } catch (err) {
    showToast(t('toast.connectionError'), 'error');
    return null;
  }
}


/* ============================================================================
 * 6. SCREEN NAVIGATION
 * ========================================================================== */

/**
 * showScreen — shows the screen with the given ID, hiding all others.
 *
 * @param {string} screenId
 */
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(function (el) {
    el.classList.remove('screen--active');
  });
  const target = document.getElementById(screenId);
  if (target) target.classList.add('screen--active');
  window.scrollTo(0, 0);
}

/**
 * showError — shows the error screen with the given message.
 *
 * @param {string} message
 */
function showError(message) {
  document.getElementById('error-message-text').textContent = message;
  showScreen('screen-error');
}

/**
 * bindGlobalEventListeners — attaches all event handlers that don't depend
 * on dynamically-generated content.
 */
function bindGlobalEventListeners() {
  document.getElementById('btn-retry').addEventListener('click', authorizeAndStart);

  document.getElementById('btn-back-to-dashboard').addEventListener('click', function () {
    showScreen('screen-dashboard');
  });

  document.getElementById('btn-update-state').addEventListener('click', openUpdateStateForm);
  document.getElementById('btn-back-from-update').addEventListener('click', function () {
    showScreen('screen-vehicle-card');
  });

  document.getElementById('btn-start-inspection').addEventListener('click', startInspectionFlow);
  document.getElementById('btn-back-from-inspection-list').addEventListener('click', function () {
    showScreen('screen-dashboard');
  });
  document.getElementById('btn-back-from-inspection-form').addEventListener('click', function () {
    showScreen('screen-inspection-list');
  });

  document.getElementById('btn-open-calendar').addEventListener('click', openRentalCalendar);
  document.getElementById('btn-back-from-calendar').addEventListener('click', function () {
    showScreen('screen-dashboard');
  });

  document.getElementById('search-input').addEventListener('input', function (e) {
    AppState.searchQuery = e.target.value.trim().toLowerCase();
    renderVehicleList();
  });

  document.getElementById('filter-select').addEventListener('change', function (e) {
    AppState.filterValue = e.target.value;
    renderVehicleList();
  });

  document.getElementById('form-update-state').addEventListener('submit', handleUpdateStateSubmit);
  document.getElementById('input-photos').addEventListener('change', function (e) {
    handlePhotoSelection(e, 'photo-preview', AppState.pendingPhotos);
  });
  document.getElementById('input-status').addEventListener('change', function (e) {
    toggleRentalFieldsVisibility(e.target.value);
  });

  document.getElementById('form-inspection').addEventListener('submit', handleInspectionSubmit);
  document.getElementById('inspection-photos').addEventListener('change', function (e) {
    handlePhotoSelection(e, 'inspection-photo-preview', AppState.pendingInspectionPhotos);
  });
}


/* ============================================================================
 * 7. DASHBOARD (stats + vehicle list)
 * ========================================================================== */

/**
 * loadDashboard — loads dashboard stats and the vehicle list in parallel,
 * then renders both blocks.
 */
async function loadDashboard() {
  const [statsResult, vehiclesResult] = await Promise.all([
    callApi('getDashboard', {}),
    callApi('getVehicles', {})
  ]);

  if (statsResult.success) {
    AppState.dashboardStats = statsResult;
    renderDashboardStats(statsResult);
  }

  if (vehiclesResult.success) {
    AppState.vehicles = vehiclesResult.vehicles;
    renderVehicleList();
  }
}

/**
 * renderDashboardStats — fills the stats card grid on the main screen.
 *
 * @param {Object} stats - result of getDashboardStats() from the server
 */
function renderDashboardStats(stats) {
  const grid = document.getElementById('stats-grid');

  const cards = [
    { value: stats.total, label: 'Total Vehicles', color: 'blue' },
    { value: stats.free, label: 'Free', color: 'green' },
    { value: stats.rented, label: 'Rented', color: 'blue' },
    { value: stats.repair, label: 'In Repair', color: 'yellow' },
    { value: stats.needsRepair, label: 'Needs Repair', color: 'red' },
    { value: stats.overdueMaintenance.length, label: 'Maintenance Overdue', color: 'red' }
  ];

  grid.innerHTML = cards.map(function (c) {
    return (
      '<div class="stat-card stat-card--' + c.color + '">' +
        '<div class="stat-card__value">' + c.value + '</div>' +
        '<div class="stat-card__label">' + escapeHtml(c.label) + '</div>' +
      '</div>'
    );
  }).join('');
}


/* ============================================================================
 * 8. SEARCH AND FILTERING
 * ========================================================================== */

/**
 * getFilteredVehicles — applies the current search query and status filter
 * to the full vehicle list in application state.
 *
 * All fields are explicitly coerced with String(... || '') before calling
 * .toLowerCase(). This matters: if a field is null/undefined/a number (e.g.
 * a plate number stored as a number in Sheets), calling .toLowerCase()
 * directly on it throws a TypeError inside the filter() callback, which
 * silently breaks the entire list (search/filter appear "dead"). Coercing
 * to a string first makes this robust regardless of how the data is typed.
 *
 * @return {Array}
 */
function getFilteredVehicles() {
  let list = AppState.vehicles;

  if (AppState.searchQuery) {
    const q = AppState.searchQuery;
    list = list.filter(function (v) {
      return (
        String(v.brand || '').toLowerCase().includes(q) ||
        String(v.model || '').toLowerCase().includes(q) ||
        String(v.plateNumber || '').toLowerCase().includes(q) ||
        String(v.vin || '').toLowerCase().includes(q) ||
        String(v.id || '').toLowerCase().includes(q)
      );
    });
  }

  if (AppState.filterValue === '__overdue') {
    list = list.filter(function (v) { return v.maintenanceOverdue; });
  } else if (AppState.filterValue === '__due_soon') {
    list = list.filter(function (v) { return v.maintenanceDueSoon; });
  } else if (AppState.filterValue === '__rental_ending') {
    list = list.filter(function (v) { return v.rentalEndingSoon; });
  } else if (AppState.filterValue !== 'all') {
    list = list.filter(function (v) { return v.status === AppState.filterValue; });
  }

  return list;
}

/**
 * renderVehicleList — renders the vehicle card list honoring the current
 * search/filter. Each card is clickable and opens the full vehicle card.
 */
function renderVehicleList() {
  const container = document.getElementById('vehicle-list');
  const list = getFilteredVehicles();

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">' + escapeHtml(t('toast.nothingFound')) + '</div>';
    return;
  }

  container.innerHTML = list.map(function (v) {
    const statusColor = getStatusColor(v.status);
    const icon = v.type === 'Moto' || v.type === 'Motorcycle' ? '🏍️' : '🚗';

    let badge = '';
    if (v.maintenanceOverdue) {
      badge = '<span class="badge badge--red">Overdue TO</span>';
    } else if (v.maintenanceDueSoon) {
      badge = '<span class="badge badge--yellow">TO Due Soon</span>';
    } else if (v.rentalEndingSoon) {
      badge = '<span class="badge badge--yellow">Rental Ending</span>';
    }

    const thumb = (v.photos && v.photos[0])
      ? '<img src="' + escapeHtml(v.photos[0]) + '" alt="" loading="lazy" onerror="this.onerror=null;this.replaceWith(document.createTextNode(\'' + icon + '\'));">'
      : icon;

    return (
      '<div class="vehicle-item" data-vehicle-id="' + escapeHtml(v.id) + '">' +
        '<div class="vehicle-item__thumb">' + thumb + '</div>' +
        '<div class="vehicle-item__info">' +
          '<div class="vehicle-item__title"><span class="status-dot status-dot--' + statusColor + '"></span>' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</div>' +
          '<div class="vehicle-item__meta">' + escapeHtml(v.plateNumber || '') + ' • ' + formatMileage(v.currentMileage) + ' km</div>' +
        '</div>' +
        badge +
      '</div>'
    );
  }).join('');

  // Attach click handlers to each card
  container.querySelectorAll('.vehicle-item').forEach(function (el) {
    el.addEventListener('click', function () {
      openVehicleCard(el.getAttribute('data-vehicle-id'));
    });
  });
}


/* ============================================================================
 * 9. VEHICLE CARD
 * ========================================================================== */

/**
 * openVehicleCard — loads the full vehicle card (with histories) and shows
 * the card screen.
 *
 * @param {string} vehicleId
 */
async function openVehicleCard(vehicleId) {
  showScreen('screen-vehicle-card');
  document.getElementById('card-content').innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';

  const result = await callApiSafe('getVehicleCard', { vehicleId: vehicleId });
  if (!result) {
    showScreen('screen-dashboard');
    return;
  }

  AppState.currentVehicleId = vehicleId;
  AppState.currentVehicleData = result;

  renderVehicleCard(result);
}

/**
 * renderVehicleCard — renders the vehicle card contents: photos, main
 * fields, rental period, comment, and three history blocks (maintenance,
 * damage, inspection).
 *
 * Photo <img> tags include an onerror handler that swaps a broken image for
 * a placeholder icon instead of showing the browser's broken-image glyph,
 * so a single bad URL (e.g. from an old-format Drive link, or a file whose
 * sharing permissions changed) doesn't visually break the whole strip.
 *
 * @param {Object} data - result of getVehicleCard() { vehicle, maintenanceHistory, damageHistory, inspectionHistory }
 */
function renderVehicleCard(data) {
  const v = data.vehicle;
  document.getElementById('card-header-title').textContent = v.brand + ' ' + v.model;

  const statusColor = getStatusColor(v.status);

  let html = '';

  // Photos
  if (v.photos && v.photos.length > 0) {
    html += '<div class="card-photo-strip">' +
      v.photos.map(function (p) {
        return '<img src="' + escapeHtml(p) + '" alt="" loading="lazy" ' +
          'onerror="this.onerror=null;this.src=\'data:image/svg+xml;utf8,' +
          '<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2296%22 height=%2296%22>' +
          '<rect width=%22100%25%22 height=%22100%25%22 fill=%22%23222%22/>' +
          '<text x=%2250%25%22 y=%2250%25%22 fill=%22%23888%22 font-size=%2214%22 text-anchor=%22middle%22 dy=%22.3em%22>N/A</text>' +
          '</svg>\';">' ;
      }).join('') +
      '</div>';
  }

  html += '<div class="card-title-row"><div class="card-title">' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</div></div>';
  html += '<div class="card-subtitle"><span class="status-dot status-dot--' + statusColor + '"></span>' + escapeHtml(v.status) + ' • ' + escapeHtml(v.plateNumber || '') + '</div>';

  html += '<div class="info-grid">' +
    infoTile(t('card.mileage'), formatMileage(v.currentMileage) + ' km') +
    infoTile(t('card.type'), v.type || '—') +
    infoTile(t('card.lastMaintenance'), v.lastMaintenanceDate || '—') +
    infoTile(t('card.nextMaintenance'), (v.nextMaintenanceKm ? v.nextMaintenanceKm + ' km' : '—') + (v.nextMaintenanceDate ? ' / ' + v.nextMaintenanceDate : '')) +
    infoTile(t('card.year'), v.year || '—') +
    infoTile(t('card.vin'), v.vin || '—') +
    infoTile(t('card.responsible'), v.responsible || '—') +
    infoTile(t('card.inspection'), v.lastInspectionDate || t('card.inspectionNone')) +
  '</div>';

  // Rental info block — only shown if rental dates are set
  if (v.rentalStartDate || v.rentalEndDate) {
    const rentalClass = v.rentalExpired ? 'rental-summary--expired' : (v.rentalEndingSoon ? 'rental-summary--ending-soon' : '');
    html += '<div class="rental-summary ' + rentalClass + '">';
    html += '<div class="rental-summary__vehicle">📅 ' + escapeHtml(t('card.rentalPeriod')) + '</div>';
    html += '<div class="rental-summary__dates">' + escapeHtml(v.rentalStartDate || '—') + ' → ' + escapeHtml(v.rentalEndDate || '—') + '</div>';
    if (v.rentalTenant) {
      html += '<div class="rental-summary__tenant">' + escapeHtml(t('card.rentalTenant')) + ': ' + escapeHtml(v.rentalTenant) + '</div>';
    }
    if (v.rentalExpired) {
      html += '<div class="rental-summary__tenant">⚠️ ' + escapeHtml(t('card.rentalExpired')) + '</div>';
    } else if (v.rentalDaysRemaining !== null && v.rentalDaysRemaining !== undefined) {
      html += '<div class="rental-summary__tenant">' + v.rentalDaysRemaining + ' ' + escapeHtml(t('card.rentalDaysLeft')) + '</div>';
    }
    html += '</div>';
  }

  if (v.comment) {
    html += '<div class="comment-box">💬 ' + escapeHtml(v.comment) + '</div>';
  }

  // Maintenance history
  html += '<div class="section-title">🔧 ' + escapeHtml(t('card.maintenanceHistory')) + '</div>';
  html += renderHistoryList(data.maintenanceHistory, function (item) {
    return escapeHtml(item.work || '—') + (item.cost ? ' · ' + escapeHtml(String(item.cost)) : '') + '<br><small>' + escapeHtml(item.executor || '') + ' · ' + formatMileage(item.mileage) + ' km</small>';
  });

  // Damage history
  html += '<div class="section-title">⚠️ ' + escapeHtml(t('card.damageHistory')) + '</div>';
  html += renderHistoryList(data.damageHistory, function (item) {
    return escapeHtml(item.description || '—') + ' <span class="badge badge--' + (item.severity === 'Critical' || item.severity === 'High' ? 'red' : 'yellow') + '">' + escapeHtml(item.severity || '') + '</span>' +
      '<br><small>' + escapeHtml(item.author || '') + ' · ' + escapeHtml(item.fixStatus || '') + '</small>';
  });

  // Inspection history
  html += '<div class="section-title">📋 ' + escapeHtml(t('card.inspectionHistory')) + '</div>';
  html += renderHistoryList(data.inspectionHistory, function (item) {
    return escapeHtml(item.notes || 'No remarks') + '<br><small>' + escapeHtml(item.author || '') + ' · ' + formatMileage(item.mileage) + ' km</small>';
  });

  document.getElementById('card-content').innerHTML = html;

  // "Update State" button is visible only to Editors
  const updateBtn = document.getElementById('btn-update-state');
  if (AppState.canEdit) {
    updateBtn.classList.remove('hidden');
  } else {
    updateBtn.classList.add('hidden');
  }
}

/**
 * infoTile — helper that generates the HTML for one info-grid tile.
 *
 * @param {string} label
 * @param {string} value
 * @return {string}
 */
function infoTile(label, value) {
  return '<div class="info-tile"><div class="info-tile__label">' + escapeHtml(label) + '</div><div class="info-tile__value">' + escapeHtml(String(value)) + '</div></div>';
}

/**
 * renderHistoryList — generates the HTML for a history list (maintenance /
 * damage / inspection). Shows a placeholder if the list is empty.
 *
 * @param {Array} items
 * @param {Function} renderItemContent - function (item) => innerHTML of the record
 * @return {string}
 */
function renderHistoryList(items, renderItemContent) {
  if (!items || items.length === 0) {
    return '<div class="empty-state" style="padding:16px;">' + escapeHtml(t('card.noRecords')) + '</div>';
  }

  return items.map(function (item) {
    return '<div class="history-item"><div class="history-item__date">' + escapeHtml(item.date || '') + '</div>' + renderItemContent(item) + '</div>';
  }).join('');
}


/* ============================================================================
 * 10. UPDATE STATE (Editor form, incl. rental fields)
 * ========================================================================== */

/**
 * openUpdateStateForm — opens the update-state form for the currently open
 * vehicle, pre-filling the mileage field with the current value and the
 * rental fields with any existing rental data.
 */
function openUpdateStateForm() {
  if (!AppState.canEdit) {
    showToast(t('toast.noEditPermission'), 'error');
    return;
  }

  const v = AppState.currentVehicleData.vehicle;

  document.getElementById('input-mileage').value = v.currentMileage || '';
  document.getElementById('input-status').value = '';
  document.getElementById('input-comment').value = '';
  document.getElementById('input-photos').value = '';
  document.getElementById('photo-preview').innerHTML = '';

  document.getElementById('input-rental-tenant').value = v.rentalTenant || '';
  document.getElementById('input-rental-start').value = toDateInputValue(v.rentalStartDate);
  document.getElementById('input-rental-end').value = toDateInputValue(v.rentalEndDate);

  AppState.pendingPhotos = [];
  AppState.pendingFaults = [];

  // Show rental fields immediately if the vehicle is currently rented or
  // already has rental dates set; otherwise hide them until "Rented" is picked.
  const shouldShowRental = v.status === APP_CONFIG.STATUS.RENTED || !!(v.rentalStartDate || v.rentalEndDate);
  setRentalFieldsVisible(shouldShowRental);

  renderFaultsGrid();
  showScreen('screen-update-state');
}

/**
 * toggleRentalFieldsVisibility — shows the rental fields block only when
 * the selected status is "Rented"; called on the status <select> change event.
 *
 * @param {string} statusValue
 */
function toggleRentalFieldsVisibility(statusValue) {
  setRentalFieldsVisible(statusValue === APP_CONFIG.STATUS.RENTED);
}

/**
 * setRentalFieldsVisible — shows/hides the rental fields block.
 *
 * @param {boolean} visible
 */
function setRentalFieldsVisible(visible) {
  const block = document.getElementById('rental-fields-block');
  if (visible) {
    block.classList.remove('hidden');
  } else {
    block.classList.add('hidden');
  }
}

/**
 * toDateInputValue — converts a "YYYY-MM-DD HH:mm" or similar date string
 * (as returned by the server) into the "YYYY-MM-DD" format required by
 * <input type="date">.
 *
 * @param {string} dateStr
 * @return {string}
 */
function toDateInputValue(dateStr) {
  if (!dateStr) return '';
  const match = String(dateStr).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/**
 * renderFaultsGrid — renders the fault checkbox grid based on
 * APP_CONFIG.FAULT_OPTIONS.
 */
function renderFaultsGrid() {
  const container = document.getElementById('faults-grid');

  container.innerHTML = APP_CONFIG.FAULT_OPTIONS.map(function (fault) {
    return (
      '<label class="fault-chip" data-fault-id="' + fault.id + '">' +
        '<input type="checkbox" value="' + fault.id + '" />' +
        '<span>' + fault.icon + ' ' + escapeHtml(fault.label) + '</span>' +
      '</label>'
    );
  }).join('');

  container.querySelectorAll('.fault-chip').forEach(function (chip) {
    const checkbox = chip.querySelector('input');
    checkbox.addEventListener('change', function () {
      chip.classList.toggle('fault-chip--checked', checkbox.checked);

      const faultId = chip.getAttribute('data-fault-id');
      const faultLabel = APP_CONFIG.FAULT_OPTIONS.find(function (f) { return f.id === faultId; }).label;

      if (checkbox.checked) {
        AppState.pendingFaults.push(faultLabel);
      } else {
        AppState.pendingFaults = AppState.pendingFaults.filter(function (f) { return f !== faultLabel; });
      }
    });
  });
}

/**
 * handleUpdateStateSubmit — handles submission of the update-state form:
 * uploads photos first (if any), then calls updateVehicleCard with all
 * changed fields, including rental dates/tenant when the "Rented" status
 * is selected.
 *
 * @param {Event} e
 */
async function handleUpdateStateSubmit(e) {
  e.preventDefault();

  const saveBtn = document.getElementById('btn-save-update');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const uploadedUrls = await uploadPendingPhotos(AppState.pendingPhotos);

    const statusValue = document.getElementById('input-status').value || undefined;

    const payload = {
      vehicleId: AppState.currentVehicleId,
      mileage: document.getElementById('input-mileage').value || undefined,
      status: statusValue,
      comment: document.getElementById('input-comment').value || undefined,
      photos: uploadedUrls,
      faults: AppState.pendingFaults
    };

    // Only send rental fields if the rental block is visible (i.e. relevant)
    const rentalBlockVisible = !document.getElementById('rental-fields-block').classList.contains('hidden');
    if (rentalBlockVisible) {
      const tenant = document.getElementById('input-rental-tenant').value;
      const startDate = document.getElementById('input-rental-start').value;
      const endDate = document.getElementById('input-rental-end').value;

      if (tenant) payload.rentalTenant = tenant;
      if (startDate) payload.rentalStartDate = startDate;
      if (endDate) payload.rentalEndDate = endDate;
    }

    const result = await callApiSafe('updateVehicleCard', payload);

    if (result) {
      showToast(t('toast.stateUpdated'), 'success');
      await openVehicleCard(AppState.currentVehicleId);
      await loadDashboard(); // refresh dashboard counters in the background
      showScreen('screen-vehicle-card');
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 ' + t('updateForm.save');
  }
}


/* ============================================================================
 * 11. INSPECTION
 * ========================================================================== */

/**
 * startInspectionFlow — starts the inspection process: shows the list of
 * all vehicles that need to be checked one by one.
 */
function startInspectionFlow() {
  if (!AppState.canEdit) {
    showToast(t('toast.noInspectionPermission'), 'error');
    return;
  }

  AppState.inspectionQueue = AppState.vehicles.slice();
  AppState.inspectionDoneIds = new Set();

  renderInspectionList();
  showScreen('screen-inspection-list');
}

/**
 * renderInspectionList — renders the vehicle list for inspection, marking
 * already-checked vehicles.
 */
function renderInspectionList() {
  const container = document.getElementById('inspection-vehicle-list');

  if (AppState.inspectionQueue.length === 0) {
    container.innerHTML = '<div class="empty-state">No vehicles to inspect</div>';
    return;
  }

  container.innerHTML = AppState.inspectionQueue.map(function (v) {
    const done = AppState.inspectionDoneIds.has(v.id);
    return (
      '<div class="inspection-item ' + (done ? 'inspection-item--done' : '') + '" data-vehicle-id="' + escapeHtml(v.id) + '">' +
        '<div>' +
          '<strong>' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</strong><br>' +
          '<small>' + escapeHtml(v.plateNumber || '') + '</small>' +
        '</div>' +
        '<div class="inspection-item__check">' + (done ? '✅' : '➡️') + '</div>' +
      '</div>'
    );
  }).join('');

  container.querySelectorAll('.inspection-item').forEach(function (el) {
    el.addEventListener('click', function () {
      openInspectionForm(el.getAttribute('data-vehicle-id'));
    });
  });
}

/**
 * openInspectionForm — opens the inspection form for a specific vehicle.
 *
 * @param {string} vehicleId
 */
function openInspectionForm(vehicleId) {
  const vehicle = AppState.inspectionQueue.find(function (v) { return String(v.id) === String(vehicleId); });
  if (!vehicle) return;

  AppState.inspectionCurrentVehicleId = vehicleId;

  document.getElementById('inspection-form-title').textContent = vehicle.brand + ' ' + vehicle.model;
  document.getElementById('inspection-mileage').value = vehicle.currentMileage || '';
  document.getElementById('inspection-notes').value = '';
  document.getElementById('inspection-photos').value = '';
  document.getElementById('inspection-photo-preview').innerHTML = '';

  AppState.pendingInspectionPhotos = [];

  showScreen('screen-inspection-form');
}

/**
 * handleInspectionSubmit — handles submission of the inspection form:
 * uploads photos, sends addInspection, marks the vehicle as checked, and
 * returns the user to the list for the next vehicle.
 *
 * @param {Event} e
 */
async function handleInspectionSubmit(e) {
  e.preventDefault();

  const saveBtn = document.getElementById('btn-save-inspection');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const uploadedUrls = await uploadPendingPhotos(AppState.pendingInspectionPhotos || []);

    const payload = {
      vehicleId: AppState.inspectionCurrentVehicleId,
      mileage: document.getElementById('inspection-mileage').value || undefined,
      photos: uploadedUrls,
      notes: document.getElementById('inspection-notes').value || undefined
    };

    const result = await callApiSafe('addInspection', payload);

    if (result) {
      AppState.inspectionDoneIds.add(AppState.inspectionCurrentVehicleId);
      showToast(t('toast.inspectionRecorded'), 'success');
      renderInspectionList();
      showScreen('screen-inspection-list');
      loadDashboard(); // refresh stats in the background, don't await
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '✅ ' + t('inspectionForm.save');
  }
}


/* ============================================================================
 * 12. RENTAL CALENDAR
 * ========================================================================== */

/**
 * openRentalCalendar — loads rental data from the server and shows the
 * rental calendar screen.
 */
async function openRentalCalendar() {
  showScreen('screen-rental-calendar');
  document.getElementById('calendar-content').innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';

  const result = await callApiSafe('getRentalCalendar', {});
  if (!result) {
    showScreen('screen-dashboard');
    return;
  }

  AppState.rentalCalendarData = result.rentals;
  AppState.calendarViewDate = new Date(); // always start on the current month
  renderRentalCalendar();
}

/**
 * renderRentalCalendar — renders a month grid highlighting days covered by
 * an active rental, followed by a list of rental summary cards sorted by
 * soonest end date (as returned by the server).
 */
function renderRentalCalendar() {
  const container = document.getElementById('calendar-content');
  const rentals = AppState.rentalCalendarData || [];

  let html = renderCalendarMonthGrid(AppState.calendarViewDate, rentals);

  html += '<div class="section-title">📋 Rentals</div>';

  if (rentals.length === 0) {
    html += '<div class="empty-state">' + escapeHtml(t('calendar.noRentals')) + '</div>';
  } else {
    html += rentals.map(function (r) {
      const cls = r.rentalExpired ? 'rental-summary--expired' : (r.rentalEndingSoon ? 'rental-summary--ending-soon' : '');
      let statusLabel = t('calendar.upcoming');
      if (r.rentalExpired) {
        statusLabel = t('calendar.expired');
      } else if (r.rentalEndingSoon) {
        statusLabel = t('calendar.endingSoon');
      } else if (r.rentalDaysRemaining !== null && r.rentalDaysRemaining !== undefined) {
        statusLabel = t('calendar.active');
      }

      return (
        '<div class="rental-summary ' + cls + '" data-vehicle-id="' + escapeHtml(r.vehicleId) + '">' +
          '<div class="rental-summary__vehicle">' + escapeHtml(r.brand) + ' ' + escapeHtml(r.model) + ' (' + escapeHtml(r.plateNumber || '') + ')</div>' +
          '<div class="rental-summary__dates">' + escapeHtml(r.rentalStartDate || '—') + ' → ' + escapeHtml(r.rentalEndDate || '—') + ' · ' + escapeHtml(statusLabel) + '</div>' +
          (r.rentalTenant ? '<div class="rental-summary__tenant">' + escapeHtml(t('card.rentalTenant')) + ': ' + escapeHtml(r.rentalTenant) + '</div>' : '') +
        '</div>'
      );
    }).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('.rental-summary[data-vehicle-id]').forEach(function (el) {
    el.addEventListener('click', function () {
      openVehicleCard(el.getAttribute('data-vehicle-id'));
    });
  });
}

/**
 * renderCalendarMonthGrid — builds a simple month-view calendar grid for
 * the given date, highlighting days that fall within any rental's
 * start/end range.
 *
 * @param {Date} viewDate - any date within the month to display
 * @param {Array} rentals - result of getRentalCalendar()
 * @return {string} HTML
 */
function renderCalendarMonthGrid(viewDate, rentals) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = firstDay.getDay();

  const today = new Date();
  const todayKey = dateKey(today);

  // Pre-compute a set of "day keys" (YYYY-MM-DD) covered by any rental, plus
  // a separate set for days covered by a rental that's ending soon, so each
  // calendar cell can be colored correctly.
  const rentalDays = new Set();
  const endingSoonDays = new Set();

  rentals.forEach(function (r) {
    if (!r.rentalStartDate && !r.rentalEndDate) return;
    const start = r.rentalStartDate ? new Date(r.rentalStartDate) : null;
    const end = r.rentalEndDate ? new Date(r.rentalEndDate) : null;
    if (!start && !end) return;

    const rangeStart = start || end;
    const rangeEnd = end || start;

    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
      const key = dateKey(d);
      rentalDays.add(key);
      if (r.rentalEndingSoon) endingSoonDays.add(key);
    }
  });

  let html = '<div class="calendar-month-nav">' +
    '<button class="btn-icon" id="btn-calendar-prev-month">←</button>' +
    '<div class="calendar-month-nav__title">' + monthNames[month] + ' ' + year + '</div>' +
    '<button class="btn-icon" id="btn-calendar-next-month">→</button>' +
  '</div>';

  html += '<div class="calendar-grid">';
  weekdayNames.forEach(function (wd) {
    html += '<div class="calendar-weekday">' + wd + '</div>';
  });

  for (let i = 0; i < startWeekday; i++) {
    html += '<div class="calendar-day calendar-day--empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(year, month, day);
    const key = dateKey(cellDate);

    let cellClass = 'calendar-day';
    if (key === todayKey) cellClass += ' calendar-day--today';
    if (endingSoonDays.has(key)) {
      cellClass += ' calendar-day--ending-soon';
    } else if (rentalDays.has(key)) {
      cellClass += ' calendar-day--has-rental';
    }

    html += '<div class="' + cellClass + '">' + day + '</div>';
  }

  html += '</div>';

  // Defer binding month-nav buttons until after this HTML is inserted into the DOM
  setTimeout(function () {
    const prevBtn = document.getElementById('btn-calendar-prev-month');
    const nextBtn = document.getElementById('btn-calendar-next-month');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        AppState.calendarViewDate = new Date(year, month - 1, 1);
        renderRentalCalendar();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        AppState.calendarViewDate = new Date(year, month + 1, 1);
        renderRentalCalendar();
      });
    }
  }, 0);

  return html;
}

/**
 * dateKey — formats a Date as a "YYYY-MM-DD" string using local time
 * components (not UTC), so calendar day comparisons match what the user sees.
 *
 * @param {Date} date
 * @return {string}
 */
function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}


/* ============================================================================
 * 13. PHOTO HANDLING
 * ========================================================================== */

/**
 * handlePhotoSelection — handles file selection via <input type="file">:
 * compresses each image and appends its base64 representation to the given
 * state array, and renders a preview thumbnail.
 *
 * @param {Event} e
 * @param {string} previewContainerId - ID of the preview container
 * @param {Array} targetArray - AppState array to push base64 data into
 */
async function handlePhotoSelection(e, previewContainerId, targetArray) {
  const files = Array.from(e.target.files || []);
  const previewContainer = document.getElementById(previewContainerId);

  for (const file of files) {
    try {
      const compressed = await compressImage(file);
      targetArray.push(compressed);

      const img = document.createElement('img');
      img.src = 'data:' + compressed.mimeType + ';base64,' + compressed.base64Data;
      previewContainer.appendChild(img);
    } catch (err) {
      showToast(t('toast.photoError'), 'error');
    }
  }
}

/**
 * compressImage — compresses an image down to APP_CONFIG.PHOTO_MAX_DIMENSION
 * on its longest side and encodes it as JPEG at the configured quality, to
 * reduce the amount of data transferred (important for a mechanic's mobile
 * connection out in the field).
 *
 * @param {File} file
 * @return {Promise<Object>} { fileName, mimeType, base64Data }
 */
function compressImage(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();

    reader.onload = function (event) {
      const img = new Image();

      img.onload = function () {
        let width = img.width;
        let height = img.height;
        const maxDim = APP_CONFIG.PHOTO_MAX_DIMENSION;

        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', APP_CONFIG.PHOTO_JPEG_QUALITY);
        const base64Data = dataUrl.split(',')[1];

        resolve({
          fileName: (file.name || 'photo') + '.jpg',
          mimeType: 'image/jpeg',
          base64Data: base64Data
        });
      };

      img.onerror = function () { reject(new Error('Could not load the image')); };
      img.src = event.target.result;
    };

    reader.onerror = function () { reject(new Error('Could not read the file')); };
    reader.readAsDataURL(file);
  });
}

/**
 * uploadPendingPhotos — sequentially uploads an array of prepared photos
 * (base64) to the server via the 'uploadPhoto' action and returns the array
 * of resulting URLs, ready to be saved in the spreadsheet.
 *
 * @param {Array} photos - array of { fileName, mimeType, base64Data }
 * @return {Promise<Array<string>>} array of URLs
 */
async function uploadPendingPhotos(photos) {
  const urls = [];

  for (const photo of photos) {
    const result = await callApiSafe('uploadPhoto', photo);
    if (result && result.url) {
      urls.push(result.url);
    }
  }

  return urls;
}


/* ============================================================================
 * 14. HELPERS
 * ========================================================================== */

/**
 * getStatusColor — maps a vehicle status to a color indicator
 * (green / blue / yellow / red), matching the values stored in
 * CONFIG.VEHICLE_STATUS on the server (English strings).
 *
 * @param {string} status
 * @return {string} 'green' | 'blue' | 'yellow' | 'red'
 */
function getStatusColor(status) {
  switch (status) {
    case APP_CONFIG.STATUS.FREE: return 'green';
    case APP_CONFIG.STATUS.RENTED: return 'blue';
    case APP_CONFIG.STATUS.REPAIR: return 'yellow';
    case APP_CONFIG.STATUS.NEEDS_REPAIR: return 'red';
    default: return 'blue';
  }
}

/**
 * formatMileage — formats a mileage number with thousands separators.
 *
 * @param {number|string} value
 * @return {string}
 */
function formatMileage(value) {
  const num = Number(value);
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US');
}

/**
 * escapeHtml — escapes HTML special characters to avoid XSS when rendering
 * user-entered data (comments, notes, etc).
 *
 * @param {string} str
 * @return {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * showToast — shows a toast notification at the bottom of the screen.
 *
 * @param {string} message
 * @param {string} [type] - 'success' | 'error' | undefined (neutral)
 */
function showToast(message, type) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast toast--visible' + (type ? ' toast--' + type : '');

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(function () {
    toast.classList.remove('toast--visible');
  }, APP_CONFIG.TOAST_DURATION);
}
