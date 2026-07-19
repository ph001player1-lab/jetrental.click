/**
 * ============================================================================
 * KOKON CARS & BIKE SERVICE — FRONTEND LOGIC (app.js)
 * ============================================================================
 * Чистый JavaScript без сторонних библиотек. Работает как SPA поверх
 * index.html, переключая видимость <section class="screen"> и заполняя их
 * данными, полученными от Google Apps Script API (Code.gs).
 *
 * СТРУКТУРА ФАЙЛА:
 *   1. КОНФИГУРАЦИЯ (все константы вынесены сюда)
 *   2. ГЛОБАЛЬНОЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ
 *   3. ИНИЦИАЛИЗАЦИЯ И АВТОРИЗАЦИЯ
 *   4. РАБОТА С API (fetch-обёртка, обработка ошибок)
 *   5. НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ
 *   6. DASHBOARD (статистика + список техники)
 *   7. ПОИСК И ФИЛЬТРАЦИЯ
 *   8. КАРТОЧКА ТЕХНИКИ
 *   9. ОБНОВЛЕНИЕ СОСТОЯНИЯ (форма Editor)
 *   10. ИНВЕНТАРИЗАЦИЯ
 *   11. РАБОТА С ФОТОГРАФИЯМИ
 *   12. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (тост, форматирование, цвета статусов)
 * ============================================================================
 */

/* ============================================================================
 * 1. КОНФИГУРАЦИЯ
 * ========================================================================== */

const APP_CONFIG = {
  // URL веб-приложения Apps Script (Deploy → New deployment → Web app).
  // ЗАМЕНИТЕ на реальный URL вашего развёрнутого Apps Script перед публикацией.
  API_URL: 'https://script.google.com/macros/s/AKfycbwH3Chyr08nakPzCPd8dxz46xJLYCKY2GElih0Dz7A462AlabYMP2q7vzYcyntycoBj/exec',

  // Список неисправностей, доступных для выбора при обновлении состояния
  FAULT_OPTIONS: [
    { id: 'oil', label: 'Масло', icon: '🛢️' },
    { id: 'brakes', label: 'Тормоза', icon: '🛑' },
    { id: 'battery', label: 'Аккумулятор', icon: '🔋' },
    { id: 'tires', label: 'Шины', icon: '🛞' },
    { id: 'turn_signal', label: 'Поворотник', icon: '↩️' },
    { id: 'headlight', label: 'Фара', icon: '💡' },
    { id: 'other', label: 'Другое', icon: '⚠️' }
  ],

  // Максимальный размер стороны фото при сжатии перед загрузкой (в пикселях)
  PHOTO_MAX_DIMENSION: 1280,
  PHOTO_JPEG_QUALITY: 0.75,

  // Длительность показа тост-уведомлений (мс)
  TOAST_DURATION: 2600
};


/* ============================================================================
 * 2. ГЛОБАЛЬНОЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ
 * ========================================================================== */

const AppState = {
  telegramId: null,
  username: null,
  userName: null,
  role: null,        // 'Viewer' | 'Editor'
  canEdit: false,

  vehicles: [],       // полный список техники (кэш последнего getVehicles)
  dashboardStats: null,

  currentVehicleId: null,   // ID открытой карточки
  currentVehicleData: null, // полные данные открытой карточки (с историями)

  // Временное состояние формы обновления/инвентаризации
  pendingPhotos: [],        // массив base64 фото, готовых к отправке
  pendingFaults: [],        // выбранные неисправности
  pendingInspectionPhotos: [],

  // Состояние процесса инвентаризации (для последовательного прохода по машинам)
  inspectionQueue: [],
  inspectionDoneIds: new Set(),
  inspectionCurrentVehicleId: null,

  searchQuery: '',
  filterValue: 'all'
};


/* ============================================================================
 * 3. ИНИЦИАЛИЗАЦИЯ И АВТОРИЗАЦИЯ
 * ========================================================================== */

/**
 * Точка входа приложения. Вызывается после загрузки DOM.
 */
document.addEventListener('DOMContentLoaded', function () {
  initTelegramWebApp();
  bindGlobalEventListeners();
  authorizeAndStart();
});

/**
 * initTelegramWebApp — инициализирует Telegram Web App SDK: сообщает
 * Telegram, что приложение готово, разворачивает его на весь экран и
 * применяет цветовую тему клиента Telegram.
 */
function initTelegramWebApp() {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    // Применяем тему Telegram к CSS-переменным, если она доступна
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
 * getTelegramUser — извлекает данные пользователя Telegram из initDataUnsafe.
 * В продакшене реальная проверка подлинности initData должна выполняться
 * на сервере (см. комментарий verifyTelegramAuth в Code.gs); здесь мы лишь
 * читаем поля для отображения и передачи telegramId в API.
 *
 * @return {Object|null} { id, username, firstName, lastName } или null
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
 * authorizeAndStart — главный сценарий запуска: получает Telegram ID,
 * проверяет его через API (action: 'authorize'), и в зависимости от
 * результата показывает либо Dashboard, либо экран "Нет доступа".
 */
async function authorizeAndStart() {
  showScreen('screen-loading');

  const telegramUser = getTelegramUser();

  if (!telegramUser) {
    // Если приложение открыто вне Telegram (например, для локальной отладки в браузере),
    // всё равно пытаемся продолжить с пустым ID — сервер вернёт "нет доступа".
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
      showError(result.error || 'Ошибка авторизации');
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
    showError('Не удалось связаться с сервером. Проверьте интернет-соединение.');
  }
}

/**
 * applyRoleToUI — показывает/скрывает элементы интерфейса, доступные только
 * редакторам (Editor), в соответствии с ролью текущего пользователя.
 * Это лишь UX-слой: реальная защита всегда выполняется на сервере.
 */
function applyRoleToUI() {
  const roleBadge = document.getElementById('user-role-badge');
  roleBadge.textContent = AppState.role === 'Editor' ? 'Редактор' : 'Наблюдатель';

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
 * 4. РАБОТА С API
 * ========================================================================== */

/**
 * callApi — универсальная обёртка над fetch() для вызова методов Apps Script.
 * Отправляет POST-запрос с JSON-телом { action, telegramId, data }.
 *
 * @param {string} action - имя действия (должно соответствовать case в Code.gs)
 * @param {Object} data - произвольные данные запроса
 * @return {Promise<Object>} разобранный JSON-ответ сервера
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
      // Используем text/plain, чтобы избежать preflight-запроса CORS,
      // который Apps Script Web App не поддерживает "из коробки".
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error('Сервер вернул код ' + response.status);
  }

  const json = await response.json();
  return json;
}

/**
 * callApiSafe — обёртка над callApi с автоматическим показом тоста при ошибке.
 * Используется в местах, где не нужно останавливать весь экран из-за сбоя
 * одного действия (например, при сохранении формы).
 *
 * @param {string} action
 * @param {Object} data
 * @return {Promise<Object|null>} результат или null при ошибке
 */
async function callApiSafe(action, data) {
  try {
    const result = await callApi(action, data);
    if (!result.success) {
      showToast(result.error || 'Произошла ошибка', 'error');
      return null;
    }
    return result;
  } catch (err) {
    showToast('Ошибка соединения с сервером', 'error');
    return null;
  }
}


/* ============================================================================
 * 5. НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ
 * ========================================================================== */

/**
 * showScreen — показывает экран с указанным ID, скрывая все остальные.
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
 * showError — показывает экран ошибки с заданным текстом.
 *
 * @param {string} message
 */
function showError(message) {
  document.getElementById('error-message-text').textContent = message;
  showScreen('screen-error');
}

/**
 * bindGlobalEventListeners — навешивает все обработчики событий,
 * которые не зависят от динамически создаваемого контента.
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

  document.getElementById('form-inspection').addEventListener('submit', handleInspectionSubmit);
  document.getElementById('inspection-photos').addEventListener('change', function (e) {
    handlePhotoSelection(e, 'inspection-photo-preview', AppState.pendingInspectionPhotos);
  });
}


/* ============================================================================
 * 6. DASHBOARD (статистика + список техники)
 * ========================================================================== */

/**
 * loadDashboard — загружает статистику Dashboard и список техники параллельно,
 * затем отрисовывает оба блока.
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
 * renderDashboardStats — заполняет сетку карточек статистики на главном экране.
 *
 * @param {Object} stats - результат getDashboardStats() с сервера
 */
function renderDashboardStats(stats) {
  const grid = document.getElementById('stats-grid');

  const cards = [
    { value: stats.total, label: 'Всего техники', color: 'blue' },
    { value: stats.free, label: 'Свободно', color: 'green' },
    { value: stats.rented, label: 'В аренде', color: 'blue' },
    { value: stats.repair, label: 'На ремонте', color: 'yellow' },
    { value: stats.needsRepair, label: 'Требует ремонта', color: 'red' },
    { value: stats.overdueMaintenance.length, label: 'Просрочено ТО', color: 'red' }
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
 * 7. ПОИСК И ФИЛЬТРАЦИЯ
 * ========================================================================== */

/**
 * getFilteredVehicles — применяет текущий поисковый запрос и фильтр статуса
 * к полному списку техники в состоянии приложения.
 *
 * @return {Array}
 */
function getFilteredVehicles() {
  let list = AppState.vehicles;

  if (AppState.searchQuery) {
    const q = AppState.searchQuery;
    list = list.filter(function (v) {
      return (
        (v.brand && v.brand.toLowerCase().includes(q)) ||
        (v.model && v.model.toLowerCase().includes(q)) ||
        (v.plateNumber && String(v.plateNumber).toLowerCase().includes(q)) ||
        (v.vin && String(v.vin).toLowerCase().includes(q)) ||
        (v.id && String(v.id).toLowerCase().includes(q))
      );
    });
  }

  if (AppState.filterValue === '__overdue') {
    list = list.filter(function (v) { return v.maintenanceOverdue; });
  } else if (AppState.filterValue === '__due_soon') {
    list = list.filter(function (v) { return v.maintenanceDueSoon; });
  } else if (AppState.filterValue !== 'all') {
    list = list.filter(function (v) { return v.status === AppState.filterValue; });
  }

  return list;
}

/**
 * renderVehicleList — отрисовывает список карточек техники с учётом
 * текущего поиска/фильтра. Каждая карточка кликабельна и открывает
 * полную карточку техники.
 */
function renderVehicleList() {
  const container = document.getElementById('vehicle-list');
  const list = getFilteredVehicles();

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
    return;
  }

  container.innerHTML = list.map(function (v) {
    const statusColor = getStatusColor(v.status);
    const icon = v.type === 'Мотоцикл' ? '🏍️' : '🚗';

    let badge = '';
    if (v.maintenanceOverdue) {
      badge = '<span class="badge badge--red">ТО просрочено</span>';
    } else if (v.maintenanceDueSoon) {
      badge = '<span class="badge badge--yellow">Скоро ТО</span>';
    }

    return (
      '<div class="vehicle-item" data-vehicle-id="' + escapeHtml(v.id) + '">' +
        '<div class="vehicle-item__thumb">' +
          (v.photos && v.photos[0] ? '<img src="' + escapeHtml(v.photos[0]) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">' : icon) +
        '</div>' +
        '<div class="vehicle-item__info">' +
          '<div class="vehicle-item__title"><span class="status-dot status-dot--' + statusColor + '"></span>' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</div>' +
          '<div class="vehicle-item__meta">' + escapeHtml(v.plateNumber || '') + ' • ' + formatMileage(v.currentMileage) + ' км</div>' +
        '</div>' +
        badge +
      '</div>'
    );
  }).join('');

  // Навешиваем обработчики клика на каждую карточку
  container.querySelectorAll('.vehicle-item').forEach(function (el) {
    el.addEventListener('click', function () {
      openVehicleCard(el.getAttribute('data-vehicle-id'));
    });
  });
}


/* ============================================================================
 * 8. КАРТОЧКА ТЕХНИКИ
 * ========================================================================== */

/**
 * openVehicleCard — загружает полную карточку техники (с историями)
 * и отображает экран карточки.
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
 * renderVehicleCard — отрисовывает содержимое карточки техники: фото, основные
 * поля, комментарий и три блока истории (ТО, повреждения, инвентаризация).
 *
 * @param {Object} data - результат getVehicleCard() { vehicle, maintenanceHistory, damageHistory, inspectionHistory }
 */
function renderVehicleCard(data) {
  const v = data.vehicle;
  document.getElementById('card-header-title').textContent = v.brand + ' ' + v.model;

  const statusColor = getStatusColor(v.status);

  let html = '';

  // Фотографии
  if (v.photos && v.photos.length > 0) {
    html += '<div class="card-photo-strip">' +
      v.photos.map(function (p) { return '<img src="' + escapeHtml(p) + '" alt="">'; }).join('') +
      '</div>';
  }

  html += '<div class="card-title-row"><div class="card-title">' + escapeHtml(v.brand) + ' ' + escapeHtml(v.model) + '</div></div>';
  html += '<div class="card-subtitle"><span class="status-dot status-dot--' + statusColor + '"></span>' + escapeHtml(v.status) + ' • ' + escapeHtml(v.plateNumber || '') + '</div>';

  html += '<div class="info-grid">' +
    infoTile('Пробег', formatMileage(v.currentMileage) + ' км') +
    infoTile('Тип', v.type || '—') +
    infoTile('Последнее ТО', v.lastMaintenanceDate || '—') +
    infoTile('Следующее ТО', (v.nextMaintenanceKm ? v.nextMaintenanceKm + ' км' : '—') + (v.nextMaintenanceDate ? ' / ' + v.nextMaintenanceDate : '')) +
    infoTile('Год выпуска', v.year || '—') +
    infoTile('VIN', v.vin || '—') +
    infoTile('Ответственный', v.responsible || '—') +
    infoTile('Инвентаризация', v.lastInspectionDate || 'не проводилась') +
  '</div>';

  if (v.comment) {
    html += '<div class="comment-box">💬 ' + escapeHtml(v.comment) + '</div>';
  }

  // История ТО
  html += '<div class="section-title">🔧 История обслуживания</div>';
  html += renderHistoryList(data.maintenanceHistory, function (item) {
    return escapeHtml(item.work || '—') + (item.cost ? ' · ' + escapeHtml(String(item.cost)) : '') + '<br><small>' + escapeHtml(item.executor || '') + ' · ' + formatMileage(item.mileage) + ' км</small>';
  });

  // История повреждений
  html += '<div class="section-title">⚠️ История повреждений</div>';
  html += renderHistoryList(data.damageHistory, function (item) {
    return escapeHtml(item.description || '—') + ' <span class="badge badge--' + (item.severity === 'Критическая' || item.severity === 'Высокая' ? 'red' : 'yellow') + '">' + escapeHtml(item.severity || '') + '</span>' +
      '<br><small>' + escapeHtml(item.author || '') + ' · ' + escapeHtml(item.fixStatus || '') + '</small>';
  });

  // История инвентаризаций
  html += '<div class="section-title">📋 История инвентаризаций</div>';
  html += renderHistoryList(data.inspectionHistory, function (item) {
    return escapeHtml(item.notes || 'Без замечаний') + '<br><small>' + escapeHtml(item.author || '') + ' · ' + formatMileage(item.mileage) + ' км</small>';
  });

  document.getElementById('card-content').innerHTML = html;

  // Кнопка "Обновить состояние" видна только Editor
  const updateBtn = document.getElementById('btn-update-state');
  if (AppState.canEdit) {
    updateBtn.classList.remove('hidden');
  } else {
    updateBtn.classList.add('hidden');
  }
}

/**
 * infoTile — вспомогательная функция для генерации HTML одной плитки в info-grid.
 *
 * @param {string} label
 * @param {string} value
 * @return {string}
 */
function infoTile(label, value) {
  return '<div class="info-tile"><div class="info-tile__label">' + escapeHtml(label) + '</div><div class="info-tile__value">' + escapeHtml(String(value)) + '</div></div>';
}

/**
 * renderHistoryList — генерирует HTML списка записей истории (ТО/повреждения/инвентаризация).
 * Если список пуст, показывает заглушку "Записей нет".
 *
 * @param {Array} items
 * @param {Function} renderItemContent - функция (item) => innerHTML содержимого записи
 * @return {string}
 */
function renderHistoryList(items, renderItemContent) {
  if (!items || items.length === 0) {
    return '<div class="empty-state" style="padding:16px;">Записей нет</div>';
  }

  return items.map(function (item) {
    return '<div class="history-item"><div class="history-item__date">' + escapeHtml(item.date || '') + '</div>' + renderItemContent(item) + '</div>';
  }).join('');
}


/* ============================================================================
 * 9. ОБНОВЛЕНИЕ СОСТОЯНИЯ (форма Editor)
 * ========================================================================== */

/**
 * openUpdateStateForm — открывает форму обновления состояния для текущей
 * открытой единицы техники, предзаполняя поле пробега текущим значением.
 */
function openUpdateStateForm() {
  if (!AppState.canEdit) {
    showToast('У вас нет прав на редактирование', 'error');
    return;
  }

  const v = AppState.currentVehicleData.vehicle;

  document.getElementById('input-mileage').value = v.currentMileage || '';
  document.getElementById('input-status').value = '';
  document.getElementById('input-comment').value = '';
  document.getElementById('input-photos').value = '';
  document.getElementById('photo-preview').innerHTML = '';

  AppState.pendingPhotos = [];
  AppState.pendingFaults = [];

  renderFaultsGrid();
  showScreen('screen-update-state');
}

/**
 * renderFaultsGrid — отрисовывает сетку чекбоксов неисправностей на основе
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
 * handleUpdateStateSubmit — обрабатывает отправку формы обновления состояния:
 * сначала загружает фотографии (если есть), затем вызывает updateVehicleCard.
 *
 * @param {Event} e
 */
async function handleUpdateStateSubmit(e) {
  e.preventDefault();

  const saveBtn = document.getElementById('btn-save-update');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Сохранение…';

  try {
    const uploadedUrls = await uploadPendingPhotos(AppState.pendingPhotos);

    const payload = {
      vehicleId: AppState.currentVehicleId,
      mileage: document.getElementById('input-mileage').value || undefined,
      status: document.getElementById('input-status').value || undefined,
      comment: document.getElementById('input-comment').value || undefined,
      photos: uploadedUrls,
      faults: AppState.pendingFaults
    };

    const result = await callApiSafe('updateVehicleCard', payload);

    if (result) {
      showToast('Состояние обновлено', 'success');
      await openVehicleCard(AppState.currentVehicleId);
      await loadDashboard(); // обновляем счётчики на главном экране в фоне
      showScreen('screen-vehicle-card');
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Сохранить';
  }
}


/* ============================================================================
 * 10. ИНВЕНТАРИЗАЦИЯ
 * ========================================================================== */

/**
 * startInspectionFlow — запускает процесс инвентаризации: показывает список
 * всей техники, которую нужно последовательно проверить.
 */
function startInspectionFlow() {
  if (!AppState.canEdit) {
    showToast('У вас нет прав на проведение инвентаризации', 'error');
    return;
  }

  AppState.inspectionQueue = AppState.vehicles.slice();
  AppState.inspectionDoneIds = new Set();

  renderInspectionList();
  showScreen('screen-inspection-list');
}

/**
 * renderInspectionList — отрисовывает список техники для инвентаризации,
 * отмечая уже проверенные единицы.
 */
function renderInspectionList() {
  const container = document.getElementById('inspection-vehicle-list');

  if (AppState.inspectionQueue.length === 0) {
    container.innerHTML = '<div class="empty-state">Список техники пуст</div>';
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
 * openInspectionForm — открывает форму инвентаризации для конкретной единицы техники.
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
 * handleInspectionSubmit — обрабатывает отправку формы инвентаризации:
 * загружает фото, отправляет addInspection, помечает машину как проверенную
 * и возвращает пользователя к списку для следующей единицы техники.
 *
 * @param {Event} e
 */
async function handleInspectionSubmit(e) {
  e.preventDefault();

  const saveBtn = document.getElementById('btn-save-inspection');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Сохранение…';

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
      showToast('Инвентаризация зафиксирована', 'success');
      renderInspectionList();
      showScreen('screen-inspection-list');
      loadDashboard(); // обновляем статистику в фоне, не дожидаясь
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '✅ Зафиксировать';
  }
}


/* ============================================================================
 * 11. РАБОТА С ФОТОГРАФИЯМИ
 * ========================================================================== */

/**
 * handlePhotoSelection — обрабатывает выбор файлов через <input type="file">:
 * сжимает каждое изображение и добавляет его base64-представление в
 * переданный массив состояния, а также отрисовывает превью.
 *
 * @param {Event} e
 * @param {string} previewContainerId - ID контейнера для превью
 * @param {Array} targetArray - массив AppState, куда добавлять base64 данные
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
      showToast('Не удалось обработать фото', 'error');
    }
  }
}

/**
 * compressImage — сжимает изображение до APP_CONFIG.PHOTO_MAX_DIMENSION по
 * длинной стороне и кодирует в JPEG с заданным качеством, чтобы уменьшить
 * объём передаваемых данных (важно для мобильного интернета механика в поле).
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

      img.onerror = function () { reject(new Error('Не удалось загрузить изображение')); };
      img.src = event.target.result;
    };

    reader.onerror = function () { reject(new Error('Не удалось прочитать файл')); };
    reader.readAsDataURL(file);
  });
}

/**
 * uploadPendingPhotos — последовательно загружает массив подготовленных фото
 * (base64) на сервер через action 'uploadPhoto' и возвращает массив
 * итоговых URL, готовых для сохранения в таблице.
 *
 * @param {Array} photos - массив { fileName, mimeType, base64Data }
 * @return {Promise<Array<string>>} массив URL
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
 * 12. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
 * ========================================================================== */

/**
 * getStatusColor — сопоставляет статус техники с цветовым индикатором
 * (green / blue / yellow / red), как того требует ТЗ.
 *
 * @param {string} status
 * @return {string} 'green' | 'blue' | 'yellow' | 'red'
 */
function getStatusColor(status) {
  switch (status) {
    case 'Свободно': return 'green';
    case 'В аренде': return 'blue';
    case 'На ремонте': return 'yellow';
    case 'Требует ремонта': return 'red';
    default: return 'blue';
  }
}

/**
 * formatMileage — форматирует число пробега с разделителями разрядов.
 *
 * @param {number|string} value
 * @return {string}
 */
function formatMileage(value) {
  const num = Number(value);
  if (isNaN(num)) return '0';
  return num.toLocaleString('ru-RU');
}

/**
 * escapeHtml — экранирует спецсимволы HTML, чтобы избежать XSS при выводе
 * данных, введённых пользователями (комментарии, замечания и т.д.).
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
 * showToast — показывает всплывающее уведомление внизу экрана.
 *
 * @param {string} message
 * @param {string} [type] - 'success' | 'error' | undefined (нейтральный)
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
