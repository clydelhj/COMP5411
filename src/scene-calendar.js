(function setupSceneCalendar() {
  'use strict';

  const picker = document.querySelector('.scene-date-picker');
  const input = picker.querySelector('#scene-date');
  const trigger = picker.querySelector('#scene-date-trigger');
  const calendar = picker.querySelector('#scene-date-calendar');
  const [months, years] = calendar.querySelectorAll('select');
  const body = calendar.querySelector('tbody');
  const previous = calendar.querySelector('[data-month-step="-1"]');
  const next = calendar.querySelector('[data-month-step="1"]');
  const today = calendar.querySelector('[data-action="today"]');
  const first = '2000-01-01', last = '2100-12-31';
  const formatDay = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
  const formatMonth = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
  const utcDay = (year, month, day) => new Date(Date.UTC(year, month, day));
  const iso = date => date.toISOString().slice(0, 10);
  const inRange = value => value >= first && value <= last;
  let cursor;

  for (let m = 0; m < 12; m++) months.add(new Option(formatMonth.format(utcDay(2000, m, 1)), m));
  for (let y = 2000; y <= 2100; y++) years.add(new Option(y, y));

  function readDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !inRange(value)) return null;
    const [y, m, d] = value.split('-').map(Number);
    const date = utcDay(y, m - 1, d);
    return iso(date) === value ? date : null;
  }

  function render() {
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth();
    years.value = year;
    months.value = month;
    previous.disabled = year === 2000 && month === 0;
    next.disabled = year === 2100 && month === 11;
    const todayISO = window.NotoEnvironment.todayInJapan();
    today.disabled = !inRange(todayISO);
    const days = utcDay(year, month + 1, 0).getUTCDate();
    const offset = (utcDay(year, month, 1).getUTCDay() + 6) % 7;
    body.replaceChildren();
    const cellCount = Math.ceil((days + offset) / 7) * 7;
    const focusedDate = iso(cursor);
    let row;
    for (let i = 0; i < cellCount; i++) {
      if (i % 7 === 0) row = body.insertRow();
      const date = utcDay(year, month, 1 - offset + i);
      const value = iso(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = date.getUTCDate();
      button.dataset.date = value;
      button.setAttribute('aria-label', formatDay.format(date));
      button.setAttribute('aria-pressed', value === input.value);
      if (value === todayISO) button.setAttribute('aria-current', 'date');
      if (date.getUTCMonth() !== month) button.className = 'adjacent-month';
      button.tabIndex = value === focusedDate ? 0 : -1;
      button.disabled = !inRange(value);
      row.insertCell().append(button);
    }
  }

  function focusDay() {
    body.querySelector('[tabindex="0"]').focus();
  }

  function open(focusGrid) {
    cursor = readDate(input.value) || readDate(window.NotoEnvironment.todayInJapan()) || readDate(first);
    render();
    calendar.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (focusGrid) focusDay();
  }

  function close(restoreFocus = false) {
    calendar.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function choose(value) {
    close(true);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function showMonth(y, m, focusGrid = false) {
    const end = utcDay(y, m + 1, 0).getUTCDate();
    const date = utcDay(y, m, Math.min(cursor.getUTCDate(), end));
    if (!inRange(iso(date))) return;
    cursor = date;
    render();
    if (focusGrid) focusDay();
  }

  trigger.addEventListener('click', () => calendar.hidden ? open(true) : close(true));
  input.addEventListener('click', () => open(false));
  input.addEventListener('input', () => {
    const date = readDate(input.value);
    if (date && !calendar.hidden) { cursor = date; render(); }
  });
  input.addEventListener('change', () => input.setAttribute('aria-invalid', !readDate(input.value)));
  for (const select of [months, years]) {
    select.addEventListener('change', () => showMonth(Number(years.value), Number(months.value)));
  }
  for (const button of [previous, next]) {
    button.addEventListener('click', () => showMonth(cursor.getUTCFullYear(), cursor.getUTCMonth() + Number(button.dataset.monthStep)));
  }
  body.addEventListener('click', event => {
    const button = event.target.closest('button[data-date]');
    if (button) choose(button.dataset.date);
  });
  today.addEventListener('click', () => choose(window.NotoEnvironment.todayInJapan()));
  calendar.querySelector('[data-action="clear"]').addEventListener('click', () => choose(''));

  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !calendar.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.target === input && event.key === 'ArrowDown') {
      event.preventDefault();
      open(true);
    } else if (event.target === input && event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      close(true);
    } else if (event.target.dataset.date) {
      const day = readDate(event.target.dataset.date);
      const weekday = (day.getUTCDay() + 6) % 7;
      const shifts = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        showMonth(day.getUTCFullYear(), day.getUTCMonth() + (event.key === 'PageUp' ? -1 : 1), true);
      } else if (Object.hasOwn(shifts, event.key)) {
        event.preventDefault();
        day.setUTCDate(day.getUTCDate() + shifts[event.key]);
        if (inRange(iso(day))) { cursor = day; render(); focusDay(); }
      }
    }
  });
  for (const event of ['pointerdown', 'focusin']) {
    document.addEventListener(event, e => { if (!calendar.hidden && !picker.contains(e.target)) close(); });
  }
  picker.closest('dialog').addEventListener('close', () => close());
})();
