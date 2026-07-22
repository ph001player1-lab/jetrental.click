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

    'lightbox.closeButton': 'Close Photo',

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
  document.getElementById('btn-calendar-today').addEventListener('click', function () {
    scrollGanttToToday(true);
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

  document.getElementById('btn-lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('btn-lightbox-close-bottom').addEventListener('click', closeLightbox);
  document.getElementById('btn-lightbox-prev').addEventListener('click', function (e) {
    e.stopPropagation();
    lightboxShowPrev();
  });
  document.getElementById('btn-lightbox-next').addEventListener('click', function (e) {
    e.stopPropagation();
    lightboxShowNext();
  });
  initLightboxGestures();
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
      v.photos.map(function (p, idx) {
        return '<img src="' + escapeHtml(p) + '" alt="" loading="lazy" class="card-photo-strip__img" data-photo-index="' + idx + '" ' +
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

  // Wire up the photo strip: tapping any photo opens the fullscreen lightbox
  // viewer, starting at the tapped photo, cycling through all of this
  // vehicle's photos.
  const photoEls = document.querySelectorAll('.card-photo-strip__img');
  photoEls.forEach(function (imgEl) {
    imgEl.addEventListener('click', function () {
      const startIndex = Number(imgEl.getAttribute('data-photo-index')) || 0;
      openLightbox(v.photos, startIndex);
    });
  });

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
 * 12. RENTAL CALENDAR — GANTT TIMELINE
 * ========================================================================== */

/**
 * GANTT_CONFIG — layout constants shared by every Gantt rendering function.
 * Kept in sync with the pixel values hard-coded in style.css (.gantt-header__day,
 * .gantt-label-col, .gantt-row) — if you change one, change both.
 */
const GANTT_CONFIG = {
  DAY_WIDTH: 36,       // px per day column
  ROW_HEIGHT: 52,       // px per vehicle row
  LABEL_COL_WIDTH: 148, // px, pinned left column
  HEADER_HEIGHT: 52,    // px, pinned top row

  // Visible window: how many days before/after today are rendered. Rentals
  // outside this window simply don't get a bar (their vehicle row still
  // shows, so nothing is silently hidden — only the bar is clipped to the
  // rendered range). 60 days back / 120 forward comfortably covers overdue,
  // active and upcoming bookings without generating an unbounded DOM.
  DAYS_BEFORE_TODAY: 60,
  DAYS_AFTER_TODAY: 120
};

/**
 * openRentalCalendar — loads rental data from the server and shows the
 * Gantt-style rental timeline screen.
 */
async function openRentalCalendar() {
  showScreen('screen-rental-calendar');
  document.getElementById('gantt-inner').innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';

  // Vehicle list may not be loaded yet if the calendar is opened very early;
  // Gantt rows need full vehicle records (brand/model/plate), not just the
  // rental-only fields getRentalCalendar returns, so make sure both are ready.
  const [rentalResult, vehiclesReady] = await Promise.all([
    callApiSafe('getRentalCalendar', {}),
    AppState.vehicles.length > 0 ? Promise.resolve(true) : callApi('getVehicles', {}).then(function (r) {
      if (r.success) AppState.vehicles = r.vehicles;
      return true;
    })
  ]);

  if (!rentalResult) {
    showScreen('screen-dashboard');
    return;
  }

  AppState.rentalCalendarData = rentalResult.rentals;
  renderRentalGantt();
}

/**
 * renderRentalGantt — builds the full Gantt chart: a pinned corner cell, a
 * pinned horizontal date header, a pinned vertical vehicle-label column, and
 * a scrollable body grid with one absolutely-positioned bar per rental.
 *
 * Every vehicle is shown as a row (not just ones with rentals) so the chart
 * reads as a resource-planning view of the whole fleet, matching how
 * project/production planners typically lay out a Gantt resource calendar.
 * Vehicles with no rental data simply show an empty row.
 */
function renderRentalGantt() {
  const container = document.getElementById('gantt-inner');
  const vehicles = AppState.vehicles;
  const rentalsByVehicle = groupRentalsByVehicle(AppState.rentalCalendarData || []);

  if (vehicles.length === 0) {
    container.innerHTML = '<div class="gantt-empty-state">' + escapeHtml(t('calendar.noRentals')) + '</div>';
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rangeStart = addDays(today, -GANTT_CONFIG.DAYS_BEFORE_TODAY);
  const totalDays = GANTT_CONFIG.DAYS_BEFORE_TODAY + GANTT_CONFIG.DAYS_AFTER_TODAY;

  const totalWidth = GANTT_CONFIG.LABEL_COL_WIDTH + totalDays * GANTT_CONFIG.DAY_WIDTH;
  container.style.width = totalWidth + 'px';

  // Two stacked flex rows: the sticky header row (corner + date header) and
  // the content row (sticky label column + scrollable body). This mirrors
  // the CSS structure in .gantt-header-row / .gantt-content-row exactly —
  // see the comment above .gantt-inner in style.css for why this two-row
  // scheme is what makes position:sticky work correctly on both axes at once.
  let html = '<div class="gantt-header-row">';
  html += renderGanttCorner();
  html += renderGanttHeader(rangeStart, totalDays, today);
  html += '</div>';

  html += '<div class="gantt-content-row">';
  html += renderGanttLabelColumn(vehicles);
  html += renderGanttBody(vehicles, rentalsByVehicle, rangeStart, totalDays, today);
  html += '</div>';

  container.innerHTML = html;

  bindGanttInteractions();
  scrollGanttToToday(false);
}

/**
 * groupRentalsByVehicle — indexes the flat rentals array from the server by
 * vehicleId, since a single vehicle can have multiple rentals (past,
 * present, and future bookings all need their own bar on the same row).
 *
 * @param {Array} rentals
 * @return {Object} { [vehicleId]: Array<rental> }
 */
function groupRentalsByVehicle(rentals) {
  const map = {};
  rentals.forEach(function (r) {
    if (!map[r.vehicleId]) map[r.vehicleId] = [];
    map[r.vehicleId].push(r);
  });
  return map;
}

/**
 * renderGanttCorner — the small pinned cell in the top-left corner, sitting
 * above both the date header and the label column.
 *
 * @return {string}
 */
function renderGanttCorner() {
  return '<div class="gantt-corner">Vehicle</div>';
}

/**
 * renderGanttHeader — the horizontal date header row, pinned to the top,
 * showing one column per visible day with weekday/weekend and "today"
 * styling, plus a month label wherever the month changes.
 *
 * Positioned with an explicit absolute left offset (rather than a margin
 * relative to preceding siblings) so its placement never depends on the
 * render order or box model of the other three Gantt pieces — each piece
 * places itself independently within the shared .gantt-inner coordinate
 * space, which is what keeps the layout correct regardless of row count.
 *
 * @param {Date} rangeStart
 * @param {number} totalDays
 * @param {Date} today
 * @return {string}
 */
function renderGanttHeader(rangeStart, totalDays, today) {
  const weekdayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayKey = dateKey(today);

  let html = '<div class="gantt-header" style="width:' + (totalDays * GANTT_CONFIG.DAY_WIDTH) + 'px;">';

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(rangeStart, i);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const isToday = dateKey(d) === todayKey;
    const isFirstOfMonth = d.getDate() === 1 || i === 0;

    let cls = 'gantt-header__day';
    if (isWeekend) cls += ' gantt-header__day--weekend';
    if (isToday) cls += ' gantt-header__day--today';

    html += '<div class="' + cls + '">' +
      (isFirstOfMonth ? '<span class="gantt-header__month-label">' + monthNames[d.getMonth()] + '</span>' : '<span style="font-size:9px;color:transparent;">.</span>') +
      '<span class="gantt-header__day-num">' + d.getDate() + '</span>' +
      '<span style="font-size:9px;">' + weekdayLetters[d.getDay()] + '</span>' +
    '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * renderGanttLabelColumn — the vertical vehicle-label column, pinned to the
 * left within the content row.
 *
 * @param {Array} vehicles
 * @return {string}
 */
function renderGanttLabelColumn(vehicles) {
  let html = '<div class="gantt-label-col">';

  vehicles.forEach(function (v) {
    html += '<div class="gantt-label" data-vehicle-id="' + escapeHtml(v.id) + '">' +
      '<div class="gantt-label__title">' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</div>' +
      '<div class="gantt-label__meta">' + escapeHtml(v.plateNumber || '') + '</div>' +
    '</div>';
  });

  html += '</div>';
  return html;
}

/**
 * renderGanttBody — the scrollable grid of day cells plus one absolutely
 * positioned bar per rental, plus the vertical "today" indicator line.
 * Sits next to the label column within the content row (normal flex flow —
 * no manual offset needed since it's a flex sibling, not an absolutely
 * positioned element).
 *
 * Grid lines and weekend striping are drawn with a single shared CSS
 * background pattern (see buildGanttGridBackground) applied to every row,
 * rather than one <div class="gantt-cell"> per day per row. At 300 vehicles
 * x 180 visible days that's the difference between 0 and 54,000 extra DOM
 * nodes — the dominant cost at that scale — so this is the key optimization
 * that keeps scrolling smooth with a large fleet.
 *
 * @param {Array} vehicles
 * @param {Object} rentalsByVehicle
 * @param {Date} rangeStart
 * @param {number} totalDays
 * @param {Date} today
 * @return {string}
 */
function renderGanttBody(vehicles, rentalsByVehicle, rangeStart, totalDays, today) {
  const bodyWidth = totalDays * GANTT_CONFIG.DAY_WIDTH;
  const gridBackground = buildGanttGridBackground(rangeStart, totalDays);

  // The grid pattern (day lines + weekend bands) is identical for every row,
  // so it's applied ONCE here as the background of the whole scrollable
  // .gantt-body, rather than being duplicated as an inline style on each of
  // the (potentially 300) .gantt-row elements. That duplication was the
  // cause of the scroll jank reported on this screen: an inline
  // background-image forces the browser to treat it as a distinct paint
  // surface per element, so scrolling had to repaint the same complex
  // multi-layer gradient hundreds of times per frame. A single shared
  // background on the container is painted once and simply scrolls with
  // the rest of the content.
  let html = '<div class="gantt-body" style="width:' + bodyWidth + 'px; ' + gridBackground + '">';

  vehicles.forEach(function (v) {
    html += '<div class="gantt-row">';

    const rentals = rentalsByVehicle[v.id] || [];
    rentals.forEach(function (r) {
      const bar = buildGanttBar(r, rangeStart, totalDays);
      if (bar) html += bar;
    });

    html += '</div>';
  });

  // Vertical "today" line spanning the full body height
  const todayOffset = daysBetweenDates(rangeStart, today) * GANTT_CONFIG.DAY_WIDTH;
  html += '<div class="gantt-today-line" style="left:' + todayOffset + 'px; height:' + (vehicles.length * GANTT_CONFIG.ROW_HEIGHT) + 'px;"></div>';

  html += '</div>';
  return html;
}

/**
 * buildGanttGridBackground — builds a single CSS `background-image` /
 * `background-size` declaration (day-separator lines + weekend striping)
 * applied ONCE to the whole .gantt-body element, using layered CSS
 * gradients. Because background-size is expressed in day-width units (not
 * percentages of a row), the same horizontal pattern repeats correctly down
 * through every row without needing to be attached to each row
 * individually — see the comment in renderGanttBody for why that matters
 * for scroll performance at 100-300+ rows.
 *
 * Three independent, non-repeating-within-themselves layers are stacked
 * (thin day-separator lines, a Saturday band, a Sunday band), each using
 * its own repeat unit. Keeping the layers separate — rather than trying to
 * encode "two 1-day bands inside one 7-day repeating gradient" as a single
 * gradient — avoids ambiguous/overlapping color-stop math and keeps the
 * output easy to verify.
 *
 * @param {Date} rangeStart
 * @param {number} totalDays
 * @return {string} a CSS "background-image: ...; background-size: ...;" declaration
 */
function buildGanttGridBackground(rangeStart, totalDays) {
  const dw = GANTT_CONFIG.DAY_WIDTH;
  const weekWidth = dw * 7;
  const startWeekday = rangeStart.getDay(); // 0 = Sunday .. 6 = Saturday

  // Day-of-week offset (from rangeStart) of the first Saturday and first
  // Sunday in the visible range — the weekend bands then repeat every 7 days.
  const satOffset = (6 - startWeekday + 7) % 7;
  const sunOffset = (0 - startWeekday + 7) % 7;

  const lineLayer = 'repeating-linear-gradient(90deg, ' +
    'rgba(0,0,0,0.045) 0, rgba(0,0,0,0.045) 1px, transparent 1px, transparent ' + dw + 'px)';

  const satLayer = 'repeating-linear-gradient(90deg, ' +
    'transparent 0px, transparent ' + (satOffset * dw) + 'px, ' +
    'rgba(0,0,0,0.035) ' + (satOffset * dw) + 'px, rgba(0,0,0,0.035) ' + ((satOffset + 1) * dw) + 'px, ' +
    'transparent ' + ((satOffset + 1) * dw) + 'px, transparent ' + weekWidth + 'px)';

  const sunLayer = 'repeating-linear-gradient(90deg, ' +
    'transparent 0px, transparent ' + (sunOffset * dw) + 'px, ' +
    'rgba(0,0,0,0.035) ' + (sunOffset * dw) + 'px, rgba(0,0,0,0.035) ' + ((sunOffset + 1) * dw) + 'px, ' +
    'transparent ' + ((sunOffset + 1) * dw) + 'px, transparent ' + weekWidth + 'px)';

  return 'background-image: ' + lineLayer + ', ' + satLayer + ', ' + sunLayer + '; ' +
    'background-size: ' + dw + 'px 100%, ' + weekWidth + 'px 100%, ' + weekWidth + 'px 100%;';
}

/**
 * buildGanttBar — computes the left offset and width for a single rental bar
 * (in days -> pixels, relative to rangeStart) and returns its HTML, or an
 * empty string if the rental falls entirely outside the rendered window.
 *
 * The bar's color category (active / ending soon / upcoming / expired) uses
 * the flags already computed server-side (rentalExpired, rentalEndingSoon)
 * plus a simple "starts in the future" check for the upcoming/green case.
 *
 * @param {Object} rental - one entry from getRentalCalendar()
 * @param {Date} rangeStart
 * @param {number} totalDays
 * @return {string}
 */
function buildGanttBar(rental, rangeStart, totalDays) {
  if (!rental.rentalStartDate && !rental.rentalEndDate) return '';

  const start = rental.rentalStartDate ? parseDateOnly(rental.rentalStartDate) : parseDateOnly(rental.rentalEndDate);
  const end = rental.rentalEndDate ? parseDateOnly(rental.rentalEndDate) : parseDateOnly(rental.rentalStartDate);

  const rangeEnd = addDays(rangeStart, totalDays);
  if (end < rangeStart || start > rangeEnd) return ''; // entirely outside the rendered window

  const clampedStart = start < rangeStart ? rangeStart : start;
  const clampedEnd = end > rangeEnd ? rangeEnd : end;

  const startOffset = daysBetweenDates(rangeStart, clampedStart);
  const durationDays = Math.max(1, daysBetweenDates(clampedStart, clampedEnd) + 1);

  const left = startOffset * GANTT_CONFIG.DAY_WIDTH;
  const width = durationDays * GANTT_CONFIG.DAY_WIDTH - 4; // 4px gap between bars

  let colorClass = 'gantt-bar--upcoming';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (rental.rentalExpired) {
    colorClass = 'gantt-bar--expired';
  } else if (rental.rentalEndingSoon) {
    colorClass = 'gantt-bar--ending-soon';
  } else if (start <= today) {
    colorClass = 'gantt-bar--active';
  } else {
    colorClass = 'gantt-bar--upcoming';
  }

  const label = rental.rentalTenant || rental.plateNumber || '';

  return '<div class="gantt-bar ' + colorClass + '" data-vehicle-id="' + escapeHtml(rental.vehicleId) +
    '" style="left:' + left + 'px; width:' + width + 'px;" title="' + escapeHtml(label) + '">' +
    escapeHtml(label) + '</div>';
}

/**
 * bindGanttInteractions — attaches click handlers to vehicle labels and
 * rental bars (both open that vehicle's full card) after the Gantt HTML has
 * been inserted into the DOM.
 */
function bindGanttInteractions() {
  document.querySelectorAll('.gantt-label[data-vehicle-id], .gantt-bar[data-vehicle-id]').forEach(function (el) {
    el.addEventListener('click', function () {
      openVehicleCard(el.getAttribute('data-vehicle-id'));
    });
  });
}

/**
 * scrollGanttToToday — scrolls the Gantt chart's horizontal axis so that
 * today's column sits near the left edge of the visible area (just past
 * the pinned label column), and resets vertical scroll to the top.
 * Called on first render and whenever the "jump to today" button is tapped.
 *
 * @param {boolean} smooth - whether to animate the scroll
 */
function scrollGanttToToday(smooth) {
  const scrollContainer = document.getElementById('gantt-scroll');
  const targetLeft = GANTT_CONFIG.DAYS_BEFORE_TODAY * GANTT_CONFIG.DAY_WIDTH - 24; // small left margin so "today" isn't flush against the label column

  scrollContainer.scrollTo({
    left: Math.max(0, targetLeft),
    top: smooth ? scrollContainer.scrollTop : 0,
    behavior: smooth ? 'smooth' : 'auto'
  });
}

/**
 * addDays — returns a new Date offset by the given number of days (can be negative).
 *
 * @param {Date} date
 * @param {number} days
 * @return {Date}
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * daysBetweenDates — whole-day difference between two Date objects (b - a),
 * ignoring time-of-day. Positive when b is after a.
 *
 * @param {Date} a
 * @param {Date} b
 * @return {number}
 */
function daysBetweenDates(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / msPerDay);
}

/**
 * parseDateOnly — parses a "YYYY-MM-DD..." date string from the server into
 * a Date set to local midnight, so day-difference math in the Gantt chart
 * isn't thrown off by time-of-day or timezone offsets.
 *
 * @param {string} dateStr
 * @return {Date}
 */
function parseDateOnly(dateStr) {
  const match = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return new Date(dateStr);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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
 * 12.5. PHOTO LIGHTBOX (fullscreen viewer with pinch/double-tap zoom + pan)
 * ========================================================================== */

/**
 * LightboxState — transient state for the fullscreen photo viewer. Kept
 * separate from AppState since it's purely UI/gesture state that never
 * needs to survive a screen change.
 */
const LightboxState = {
  photos: [],
  currentIndex: 0,

  // Current zoom/pan transform applied to the image
  scale: 1,
  minScale: 1,
  maxScale: 4,
  translateX: 0,
  translateY: 0,

  // Pointer tracking for pan and pinch gestures
  activePointers: new Map(), // pointerId -> {x, y}
  pinchStartDistance: 0,
  pinchStartScale: 1,
  panStart: null, // {x, y, translateX, translateY}

  lastTapTime: 0
};

/**
 * openLightbox — opens the fullscreen photo viewer for a given photo array,
 * starting at startIndex. Called when the user taps any vehicle photo.
 *
 * @param {Array<string>} photos - photo URLs (already normalized by the server)
 * @param {number} startIndex
 */
function openLightbox(photos, startIndex) {
  if (!photos || photos.length === 0) return;

  LightboxState.photos = photos;
  LightboxState.currentIndex = Math.max(0, Math.min(startIndex || 0, photos.length - 1));

  document.getElementById('lightbox').classList.add('lightbox--visible');
  showLightboxPhoto(LightboxState.currentIndex);
}

/**
 * closeLightbox — hides the fullscreen photo viewer and resets zoom/pan state.
 */
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('lightbox--visible');
  LightboxState.photos = [];
  LightboxState.activePointers.clear();
}

/**
 * showLightboxPhoto — displays the photo at the given index, resets zoom/pan
 * to the default 1:1 view, and updates the counter / nav button visibility.
 *
 * @param {number} index
 */
function showLightboxPhoto(index) {
  LightboxState.currentIndex = index;

  const img = document.getElementById('lightbox-image');
  img.src = LightboxState.photos[index];

  resetLightboxTransform();

  document.getElementById('lightbox-counter').textContent = (index + 1) + ' / ' + LightboxState.photos.length;

  const prevBtn = document.getElementById('btn-lightbox-prev');
  const nextBtn = document.getElementById('btn-lightbox-next');
  const multiple = LightboxState.photos.length > 1;
  prevBtn.classList.toggle('hidden', !multiple);
  nextBtn.classList.toggle('hidden', !multiple);
}

/**
 * lightboxShowPrev / lightboxShowNext — navigate to the adjacent photo,
 * wrapping around at the ends.
 */
function lightboxShowPrev() {
  const count = LightboxState.photos.length;
  showLightboxPhoto((LightboxState.currentIndex - 1 + count) % count);
}

function lightboxShowNext() {
  const count = LightboxState.photos.length;
  showLightboxPhoto((LightboxState.currentIndex + 1) % count);
}

/**
 * resetLightboxTransform — resets zoom/pan to the default (fit, centered) view.
 */
function resetLightboxTransform() {
  LightboxState.scale = 1;
  LightboxState.translateX = 0;
  LightboxState.translateY = 0;
  applyLightboxTransform();
}

/**
 * applyLightboxTransform — writes the current scale/translate state to the
 * image's CSS transform. Called after every gesture update.
 */
function applyLightboxTransform() {
  const img = document.getElementById('lightbox-image');
  img.style.transform = 'translate(' + LightboxState.translateX + 'px, ' + LightboxState.translateY + 'px) scale(' + LightboxState.scale + ')';
}

/**
 * clampLightboxPan — keeps the pan offset within reasonable bounds so the
 * image can't be dragged completely off-screen. Uses a generous margin
 * proportional to the current zoom level rather than exact edge math, which
 * keeps the gesture code simple while still feeling controlled.
 */
function clampLightboxPan() {
  const viewport = document.getElementById('lightbox-viewport');
  const maxOffsetX = viewport.clientWidth * (LightboxState.scale - 1) / 2 + viewport.clientWidth * 0.15;
  const maxOffsetY = viewport.clientHeight * (LightboxState.scale - 1) / 2 + viewport.clientHeight * 0.15;

  LightboxState.translateX = Math.max(-maxOffsetX, Math.min(maxOffsetX, LightboxState.translateX));
  LightboxState.translateY = Math.max(-maxOffsetY, Math.min(maxOffsetY, LightboxState.translateY));
}

/**
 * initLightboxGestures — sets up Pointer Events on the lightbox viewport to
 * support:
 *   - one-finger drag: pan (only meaningful once zoomed in)
 *   - two-finger pinch: zoom in/out, anchored at the pinch midpoint
 *   - double-tap: toggle between fit (1x) and 2.5x zoom, centered on the tap
 *
 * Pointer Events (rather than separate touch/mouse handlers) let the same
 * code handle both touch devices and desktop mouse dragging for free.
 * Called once at startup; the viewport element itself never changes.
 */
function initLightboxGestures() {
  const viewport = document.getElementById('lightbox-viewport');

  viewport.addEventListener('pointerdown', function (e) {
    viewport.setPointerCapture(e.pointerId);
    LightboxState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (LightboxState.activePointers.size === 1) {
      LightboxState.panStart = {
        x: e.clientX,
        y: e.clientY,
        translateX: LightboxState.translateX,
        translateY: LightboxState.translateY
      };
    } else if (LightboxState.activePointers.size === 2) {
      // A second finger just landed — start a pinch gesture from here.
      LightboxState.pinchStartDistance = getPointerDistance();
      LightboxState.pinchStartScale = LightboxState.scale;
      LightboxState.panStart = null;
    }
  });

  viewport.addEventListener('pointermove', function (e) {
    if (!LightboxState.activePointers.has(e.pointerId)) return;
    LightboxState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (LightboxState.activePointers.size === 2) {
      // Pinch-to-zoom: scale relative to the distance when the second finger touched down.
      const distance = getPointerDistance();
      if (LightboxState.pinchStartDistance > 0) {
        const nextScale = LightboxState.pinchStartScale * (distance / LightboxState.pinchStartDistance);
        LightboxState.scale = Math.max(LightboxState.minScale, Math.min(LightboxState.maxScale, nextScale));
        clampLightboxPan();
        applyLightboxTransform();
      }
    } else if (LightboxState.activePointers.size === 1 && LightboxState.panStart && LightboxState.scale > 1) {
      // Single-finger pan — only active once zoomed in, so a plain swipe at
      // 1x zoom is free to be interpreted as "next/previous photo" instead.
      const dx = e.clientX - LightboxState.panStart.x;
      const dy = e.clientY - LightboxState.panStart.y;
      LightboxState.translateX = LightboxState.panStart.translateX + dx;
      LightboxState.translateY = LightboxState.panStart.translateY + dy;
      clampLightboxPan();
      applyLightboxTransform();
    }
  });

  function endPointer(e) {
    const wasSinglePointerTap = LightboxState.activePointers.size === 1 && LightboxState.scale === 1;
    let swipeDeltaX = 0;

    if (wasSinglePointerTap && LightboxState.panStart) {
      swipeDeltaX = e.clientX - LightboxState.panStart.x;
    }

    LightboxState.activePointers.delete(e.pointerId);

    if (LightboxState.activePointers.size < 2) {
      LightboxState.pinchStartDistance = 0;
    }

    if (LightboxState.activePointers.size === 0) {
      // At 1x zoom, a horizontal swipe navigates between photos (natural
      // gallery gesture); a short tap with negligible movement is treated
      // as a potential double-tap-to-zoom below.
      if (wasSinglePointerTap && LightboxState.photos.length > 1 && Math.abs(swipeDeltaX) > 60) {
        if (swipeDeltaX < 0) {
          lightboxShowNext();
        } else {
          lightboxShowPrev();
        }
      } else if (wasSinglePointerTap && Math.abs(swipeDeltaX) < 10) {
        handleLightboxTap(e);
      }

      LightboxState.panStart = null;
    }
  }

  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  // Mouse wheel: convenient zoom for desktop testing/usage.
  viewport.addEventListener('wheel', function (e) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    LightboxState.scale = Math.max(LightboxState.minScale, Math.min(LightboxState.maxScale, LightboxState.scale + delta));
    clampLightboxPan();
    applyLightboxTransform();
  }, { passive: false });
}

/**
 * getPointerDistance — Euclidean distance between the two currently active
 * pointers, used to measure pinch gesture scale changes.
 *
 * @return {number}
 */
function getPointerDistance() {
  const points = Array.from(LightboxState.activePointers.values());
  if (points.length < 2) return 0;
  const dx = points[0].x - points[1].x;
  const dy = points[0].y - points[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * handleLightboxTap — implements double-tap-to-zoom: two taps within 300ms
 * toggle between the fit view (1x) and a fixed 2.5x zoom, centered roughly
 * on the tap location. A single tap does nothing (navigation happens via
 * swipe or the prev/next buttons, so a lone tap doesn't accidentally zoom).
 *
 * @param {PointerEvent} e
 */
function handleLightboxTap(e) {
  const now = Date.now();
  const isDoubleTap = (now - LightboxState.lastTapTime) < 300;
  LightboxState.lastTapTime = now;

  if (!isDoubleTap) return;

  if (LightboxState.scale > 1) {
    resetLightboxTransform();
  } else {
    const viewport = document.getElementById('lightbox-viewport');
    const rect = viewport.getBoundingClientRect();
    const offsetX = (e.clientX - rect.left - rect.width / 2);
    const offsetY = (e.clientY - rect.top - rect.height / 2);

    LightboxState.scale = 2.5;
    // Shift the image so the tapped point stays roughly under the finger.
    LightboxState.translateX = -offsetX * (LightboxState.scale - 1);
    LightboxState.translateY = -offsetY * (LightboxState.scale - 1);
    clampLightboxPan();
    applyLightboxTransform();
  }
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
