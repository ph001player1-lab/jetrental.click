/**
 * Перевод коротких описаний техники («200 h.p. · Hybrid», «350 cm³») по словарю:
 * английский, русский, тайский, китайский. Числа, модели и сокращения (ABS, LED)
 * остаются как есть; незнакомые слова тоже остаются — их возвращаем в unknown,
 * чтобы сотрудник поправил вручную.
 *   window.SpecTranslate.translate('200 л.с. · Гибрид', 'en') → { text: '200 h.p. · Hybrid', unknown: [] }
 */
(() => {
  // Каждая строка — одно понятие на 4 языках; alt — другие написания (любой язык)
  const TERMS = [
    { en: 'h.p.', ru: 'л.с.', th: 'แรงม้า', zh: '马力', alt: ['hp', 'h.p', 'hp.', 'л. с.', 'лс', 'л.с'] },
    { en: 'cm³', ru: 'см³', th: 'ซีซี', zh: 'cc', alt: ['cc', 'cm3', 'см3', 'куб.см', 'куб. см', 'кубов'] },
    { en: 'hybrid', ru: 'гибрид', th: 'ไฮบริด', zh: '混合动力', alt: ['гибридный'] },
    { en: 'seats', ru: 'мест', th: 'ที่นั่ง', zh: '座', alt: ['seat', 'seater', 'места', 'место'], ruForms: { one: 'место', few: 'места', many: 'мест' } },
    { en: 'doors', ru: 'дверей', th: 'ประตู', zh: '门', alt: ['door', 'двери', 'дверь'], ruForms: { one: 'дверь', few: 'двери', many: 'дверей' } },
    { en: '4WD', ru: 'полный привод', th: 'ขับเคลื่อน 4 ล้อ', zh: '四驱', alt: ['4x4', '4×4', 'awd', 'полный'] },
    { en: 'automatic', ru: 'автомат', th: 'เกียร์อัตโนมัติ', zh: '自动挡', alt: ['auto', 'at', 'акпп', 'automatic transmission'] },
    { en: 'manual', ru: 'механика', th: 'เกียร์ธรรมดา', zh: '手动挡', alt: ['mt', 'мкпп'] },
    { en: 'electric', ru: 'электро', th: 'ไฟฟ้า', zh: '电动', alt: ['ev', 'электрический', 'электромобиль'] },
    { en: 'diesel', ru: 'дизель', th: 'ดีเซล', zh: '柴油' },
    { en: 'petrol', ru: 'бензин', th: 'เบนซิน', zh: '汽油', alt: ['gasoline'] },
    { en: 'turbo', ru: 'турбо', th: 'เทอร์โบ', zh: '涡轮增压' },
    { en: 'SUV', ru: 'кроссовер', th: 'SUV', zh: 'SUV', alt: ['внедорожник', 'джип'] },
    { en: 'pickup', ru: 'пикап', th: 'กระบะ', zh: '皮卡', alt: ['pick-up', 'pick up'] },
    { en: 'minivan', ru: 'минивэн', th: 'รถตู้', zh: '商务车', alt: ['van', 'mpv', 'минивен'] },
    { en: 'sedan', ru: 'седан', th: 'ซีดาน', zh: '轿车' },
    { en: 'hatchback', ru: 'хэтчбек', th: 'แฮทช์แบ็ก', zh: '两厢车', alt: ['хетчбек'] },
    { en: 'sport', ru: 'спорт', th: 'สปอร์ต', zh: '运动' },
    { en: 'cruiser', ru: 'круизер', th: 'ครูเซอร์', zh: '巡航车' },
    { en: 'scooter', ru: 'скутер', th: 'สกู๊ตเตอร์', zh: '踏板车' },
    { en: 'motorbike', ru: 'мотоцикл', th: 'มอเตอร์ไซค์', zh: '摩托车', alt: ['motorcycle'] },
    { en: 'new', ru: 'новый', th: 'ใหม่', zh: '新款', alt: ['новая', 'новое'] },
    { en: 'top case', ru: 'кофр', th: 'กล่องท้าย', zh: '尾箱', alt: ['topcase', 'top box'] },
    { en: 'child seat', ru: 'детское кресло', th: 'คาร์ซีทเด็ก', zh: '儿童座椅', alt: ['baby seat'] },
    { en: 'helmet', ru: 'шлем', th: 'หมวกกันน็อก', zh: '头盔', alt: ['helmets', 'шлемы'] },
    { en: 'L', ru: 'л', th: 'ลิตร', zh: '升', alt: ['литр', 'литра', 'литров'] }
  ];
  const LANGS = ['en', 'ru', 'th', 'zh'];
  const MAX_WORDS = 3;

  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const LOOKUP = new Map();
  for (const term of TERMS) {
    for (const variant of [...LANGS.map((l) => term[l]), ...(term.alt || [])]) {
      if (!LOOKUP.has(norm(variant))) LOOKUP.set(norm(variant), term);
    }
  }
  // Тайские и китайские слова пишут слитно с числами («200马力») — ищем их внутри слов
  const GLUED = [...LOOKUP.keys()].filter((k) => /[฀-๿一-鿿]/.test(k)).sort((a, b) => b.length - a.length);

  /** Слова и разделители: [{ word: '200' }, { sep: ' ' }, …] */
  function tokenize(text) {
    const tokens = [];
    for (const piece of String(text).split(/(\s*[·,;/+()]\s*|\s+)/)) {
      if (!piece) continue;
      if (/^\s*[·,;/+()]?\s*$/.test(piece)) { tokens.push({ sep: piece }); continue; }
      // Отделяем числа от слитно написанных единиц («200马力», «125cc») и знакомые слова друг от друга.
      // glue — на месте разреза не было пробела: по-китайски так и пишем, на других языках — через пробел
      let rest = piece;
      while (rest) {
        if (LOOKUP.has(norm(rest))) { tokens.push({ word: rest }); break; }
        const num = /^[\d.,–\-×x]+(?=\p{L})/u.exec(rest);
        const after = num ? rest.slice(num[0].length) : '';
        if (num && /\d/.test(num[0]) && (LOOKUP.has(norm(after)) || /^[฀-๿一-鿿]/.test(after))) {
          tokens.push({ word: num[0] }, { sep: '', glue: true });
          rest = after;
          continue;
        }
        const glued = GLUED.find((k) => rest.toLowerCase().startsWith(k));
        if (glued && glued.length < rest.length) { tokens.push({ word: rest.slice(0, glued.length) }, { sep: '', glue: true }); rest = rest.slice(glued.length); continue; }
        tokens.push({ word: rest });
        rest = '';
      }
    }
    return tokens;
  }

  const isNumber = (w) => /^[\d.,–\-×x+]+$/.test(w) && /\d/.test(w);
  // Сокращения и модели: ABS, LED, XSR900, 2024 — не переводятся
  const keepAsIs = (w) => isNumber(w) || /^[A-Z0-9-]{2,8}$/.test(w) || /\d/.test(w) || !/\p{L}/u.test(w);

  /** Русская форма слова после числа: 1 место, 2 места, 5 мест */
  function ruForm(term, prevNumber) {
    if (!term.ruForms || !prevNumber) return term.ru;
    const n = Number(String(prevNumber).split(/[–\-]/).pop().replace(',', '.'));
    if (!Number.isFinite(n) || !Number.isInteger(n)) return term.ruForms.few;
    return term.ruForms[new Intl.PluralRules('ru').select(n)] || term.ru;
  }

  function translate(text, to) {
    const tokens = tokenize(text);
    const unknown = [];
    const out = [];
    let lastWord = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.sep !== undefined) { out.push(token.glue ? (to === 'zh' ? '' : ' ') : token.sep); continue; }
      // Самое длинное совпадение из 1–3 слов подряд («полный привод», «ขับเคลื่อน 4 ล้อ»)
      let match = null;
      for (let n = MAX_WORDS; n >= 1 && !match; n--) {
        const words = [];
        let j = i;
        while (j < tokens.length && words.length < n) {
          if (tokens[j].word !== undefined) words.push(tokens[j].word);
          else if (!tokens[j].glue && !/^\s+$/.test(tokens[j].sep)) break;
          j++;
        }
        if (words.length === n) {
          const term = LOOKUP.get(norm(words.join(' ')));
          if (term && (n > 1 || !/^\d+$/.test(words[0]))) match = { term, end: j };
        }
      }
      if (match) {
        out.push(to === 'ru' ? ruForm(match.term, lastWord) : match.term[to]);
        i = match.end - 1;
        lastWord = null;
        continue;
      }
      if (!keepAsIs(token.word)) unknown.push(token.word);
      out.push(token.word);
      lastWord = isNumber(token.word) ? token.word : null;
    }
    let result = out.join('');
    // Первая буква каждой части («· гибрид» → «· Гибрид»)
    result = result.replace(/(^|·\s*)(\p{Ll})/gu, (m, before, letter) => before + letter.toUpperCase());
    // По-китайски число и слово пишут слитно: «200马力», «9–11座»
    if (to === 'zh') result = result.replace(/(\d)\s+([一-鿿])/g, '$1$2');
    return { text: result, unknown: [...new Set(unknown)] };
  }

  window.SpecTranslate = { translate, LANGS };
})();
