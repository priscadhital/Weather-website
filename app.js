(function () {
  "use strict";

  const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const SUGGEST_DEBOUNCE_MS = 280;
  const SUGGEST_MIN_CHARS = 2;
  const REFRESH_MS = 5 * 60 * 1000;

  const els = {
    form: document.getElementById("search-form"),
    input: document.getElementById("location-input"),
    btn: document.getElementById("btn-search"),
    btnCity: document.getElementById("btn-city"),
    suggestions: document.getElementById("suggestions"),
    weatherSection: document.getElementById("weather-section"),
    weatherCard: document.getElementById("weather-card"),
    errorMsg: document.getElementById("error-msg"),
    emptyState: document.getElementById("empty-state"),
    placeName: document.getElementById("place-name"),
    placeMeta: document.getElementById("place-meta"),
    updated: document.getElementById("updated"),
    temperature: document.getElementById("temperature"),
    unit: document.getElementById("unit"),
    conditionText: document.getElementById("condition-text"),
    conditionIcon: document.getElementById("condition-icon"),
    feelsLike: document.getElementById("feels-like"),
    humidity: document.getElementById("humidity"),
    wind: document.getElementById("wind"),
    unitC: document.getElementById("unit-c"),
    unitF: document.getElementById("unit-f"),
    livePill: document.getElementById("live-pill"),
    liveClock: document.getElementById("live-clock"),
  };

  let lastCelsius = null;
  let lastWindKmh = null;
  let useFahrenheit = false;
  let lastPlace = null;
  let suggestTimer = null;
  let suggestHighlight = -1;
  let suggestResults = [];
  let clockTimer = null;
  let refreshTimer = null;
  let lastWeatherTime = null;

  function weatherFromCode(code, isDay) {
    const day = isDay === 1;
    if (code === 0) return { label: "Clear sky", icon: day ? "☀️" : "🌙" };
    if (code === 1) return { label: "Mainly clear", icon: day ? "🌤️" : "🌙" };
    if (code === 2) return { label: "Partly cloudy", icon: day ? "⛅" : "☁️" };
    if (code === 3) return { label: "Overcast", icon: "☁️" };
    if (code === 45 || code === 48) return { label: "Fog", icon: "🌫️" };
    if (code >= 51 && code <= 55) return { label: "Drizzle", icon: "🌦️" };
    if (code >= 61 && code <= 65) return { label: "Rain", icon: "🌧️" };
    if (code >= 71 && code <= 77) return { label: "Snow", icon: "❄️" };
    if (code >= 80 && code <= 82) return { label: "Rain showers", icon: "🌧️" };
    if (code >= 85 && code <= 86) return { label: "Snow showers", icon: "🌨️" };
    if (code >= 95 && code <= 99) return { label: "Thunderstorm", icon: "⛈️" };
    return { label: "Mixed conditions", icon: "🌡️" };
  }

  function sceneFromWeather(code, isDay) {
    const day = isDay === 1;
    if (code >= 95 && code <= 99) return "thunder";
    if (code >= 71 && code <= 77 || code >= 85 && code <= 86) return "snow";
    if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return "rain";
    if (code >= 51 && code <= 55) return "drizzle";
    if (code === 45 || code === 48) return "fog";
    if (code === 3) return "overcast";
    if (code === 2 || code === 1) return day ? "partly-cloudy" : "cloudy-night";
    if (code === 0) return day ? "clear-day" : "clear-night";
    return day ? "partly-cloudy" : "cloudy-night";
  }

  function setWeatherScene(code, isDay) {
    document.body.dataset.scene = sceneFromWeather(code, isDay);
  }

  function resetScene() {
    document.body.dataset.scene = "default";
  }

  function formatPlace(r) {
    const parts = [r.name];
    if (r.admin1) parts.push(r.admin1);
    if (r.country) parts.push(r.country);
    return parts.filter(Boolean).join(", ");
  }

  function formatMeta(r) {
    const bits = [];
    if (r.country_code) bits.push(r.country_code);
    if (r.latitude != null && r.longitude != null) {
      bits.push(`${Number(r.latitude).toFixed(2)}°, ${Number(r.longitude).toFixed(2)}°`);
    }
    return bits.join(" · ");
  }

  function setLoading(loading) {
    els.btn.disabled = loading;
    els.btn.classList.toggle("loading", loading);
    const spinner = els.btn.querySelector(".btn-spinner");
    if (spinner) spinner.hidden = !loading;
  }

  function showError(text) {
    els.errorMsg.textContent = text;
    els.errorMsg.hidden = false;
  }

  function hideError() {
    els.errorMsg.hidden = true;
    els.errorMsg.textContent = "";
  }

  function displayTemp(c) {
    if (c == null) return "n/a";
    if (useFahrenheit) {
      return Math.round((c * 9) / 5 + 32).toString();
    }
    return Math.round(c).toString();
  }

  function displayWindKmh(kmh) {
    if (kmh == null) return "n/a";
    if (useFahrenheit) {
      const mph = kmh * 0.621371;
      return `${Math.round(mph)} mph`;
    }
    return `${Math.round(kmh)} km/h`;
  }

  function updateReadings() {
    els.unit.textContent = useFahrenheit ? "°F" : "°C";
    if (lastCelsius != null) {
      els.temperature.textContent = displayTemp(lastCelsius.current);
      els.feelsLike.textContent = `${displayTemp(lastCelsius.apparent)}${useFahrenheit ? "°F" : "°C"}`;
    }
    if (lastWindKmh != null) {
      els.wind.textContent = displayWindKmh(lastWindKmh);
    }
  }

  function setUnitFahrenheit(on) {
    useFahrenheit = on;
    els.unitC.classList.toggle("active", !on);
    els.unitF.classList.toggle("active", on);
    els.unitC.setAttribute("aria-pressed", !on ? "true" : "false");
    els.unitF.setAttribute("aria-pressed", on ? "true" : "false");
    updateReadings();
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Network error. Please try again.");
    return res.json();
  }

  async function geocodeFirst(query) {
    const params = new URLSearchParams({
      name: query.trim(),
      count: "8",
      language: "en",
      format: "json",
    });
    const data = await fetchJson(`${GEO_URL}?${params}`);
    if (!data.results || data.results.length === 0) {
      throw new Error("No places matched. Try another city, state, or country.");
    }
    return data.results[0];
  }

  async function geocodeMany(query, count) {
    const params = new URLSearchParams({
      name: query.trim(),
      count: String(count),
      language: "en",
      format: "json",
    });
    const data = await fetchJson(`${GEO_URL}?${params}`);
    return data.results || [];
  }

  async function fetchWeather(lat, lon) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "weather_code",
        "wind_speed_10m",
        "is_day",
      ].join(","),
      timezone: "auto",
    });
    const data = await fetchJson(`${FORECAST_URL}?${params}`);
    const cur = data.current;
    if (!cur) throw new Error("Weather data unavailable for this location.");
    return cur;
  }

  function refreshCardAnimation() {
    els.weatherSection.style.animation = "none";
    els.weatherSection.offsetHeight;
    els.weatherSection.style.animation = "";
    const stats = els.weatherCard.querySelectorAll(".stat");
    stats.forEach((s) => {
      s.style.animation = "none";
      s.offsetHeight;
      s.style.animation = "";
    });
  }

  function updateUpdatedLine() {
    if (!lastWeatherTime) return;
    const t = new Date(lastWeatherTime);
    els.updated.textContent = `Data from ${t.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })} · refreshes every few minutes`;
  }

  function tickLiveClock() {
    if (!els.liveClock) return;
    const now = new Date();
    els.liveClock.textContent = now.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function startLiveUi() {
    els.livePill.hidden = false;
    tickLiveClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(tickLiveClock, 1000);
    updateUpdatedLine();
  }

  function stopLiveUi() {
    els.livePill.hidden = true;
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function applyWeatherToDom(place, cur) {
    const { label, icon } = weatherFromCode(cur.weather_code, cur.is_day);

    lastCelsius = {
      current: cur.temperature_2m,
      apparent: cur.apparent_temperature,
    };
    lastWindKmh = cur.wind_speed_10m;
    lastWeatherTime = cur.time ? new Date(cur.time) : new Date();

    els.placeName.textContent = formatPlace(place);
    els.placeMeta.textContent = formatMeta(place);
    els.conditionIcon.textContent = icon;
    els.conditionText.textContent = label;
    els.humidity.textContent =
      cur.relative_humidity_2m != null ? `${Math.round(cur.relative_humidity_2m)}%` : "n/a";

    updateReadings();
    setWeatherScene(cur.weather_code, cur.is_day);
    updateUpdatedLine();
  }

  async function loadWeatherForPlace(place, opts) {
    const silent = opts && opts.silent;
    const manageBtnLoading = !silent && !(opts && opts.manageLoading === false);
    if (!silent) hideError();
    if (manageBtnLoading) setLoading(true);
    try {
      const cur = await fetchWeather(place.latitude, place.longitude);
      lastPlace = place;
      applyWeatherToDom(place, cur);

      if (!silent) {
        els.emptyState.hidden = true;
        els.weatherSection.hidden = false;
        refreshCardAnimation();
        startLiveUi();
        scheduleRefresh();
      } else {
        refreshCardAnimation();
      }
    } catch (e) {
      if (!silent) {
        els.weatherSection.hidden = true;
        els.emptyState.hidden = false;
        stopLiveUi();
        resetScene();
        showError(e instanceof Error ? e.message : "Something went wrong.");
      }
    } finally {
      if (manageBtnLoading) setLoading(false);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (lastPlace) loadWeatherForPlace(lastPlace, { silent: true });
    }, REFRESH_MS);
  }

  async function search(query) {
    hideSuggestions();
    setLoading(true);
    try {
      const place = await geocodeFirst(query);
      await loadWeatherForPlace(place, { silent: false, manageLoading: false });
    } finally {
      setLoading(false);
    }
  }

  function suggestionCombo() {
    return els.input.closest(".input-combo");
  }

  function hideSuggestions() {
    const combo = suggestionCombo();
    if (combo) combo.classList.remove("is-open");
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = "";
    suggestResults = [];
    suggestHighlight = -1;
    els.input.setAttribute("aria-expanded", "false");
  }

  function renderSuggestions(results) {
    suggestResults = results;
    suggestHighlight = results.length ? 0 : -1;
    els.suggestions.innerHTML = "";
    results.forEach(function (r, i) {
      const li = document.createElement("li");
      li.className = "suggestion-item";
      li.setAttribute("role", "option");
      li.id = "suggest-" + i;
      li.dataset.index = String(i);
      li.textContent = formatPlace(r);
      if (i === 0) li.setAttribute("aria-selected", "true");
      els.suggestions.appendChild(li);
    });
    els.suggestions.hidden = results.length === 0;
    const combo = suggestionCombo();
    if (combo) combo.classList.toggle("is-open", results.length > 0);
    els.input.setAttribute("aria-expanded", results.length > 0 ? "true" : "false");
    highlightSuggestion(suggestHighlight);
  }

  function highlightSuggestion(index) {
    const items = els.suggestions.querySelectorAll(".suggestion-item");
    items.forEach(function (el, i) {
      el.classList.toggle("is-active", i === index);
      el.setAttribute("aria-selected", i === index ? "true" : "false");
    });
  }

  async function runSuggest() {
    const q = els.input.value.trim();
    if (q.length < SUGGEST_MIN_CHARS) {
      hideSuggestions();
      return;
    }
    try {
      const results = await geocodeMany(q, 10);
      renderSuggestions(results);
    } catch {
      hideSuggestions();
    }
  }

  function queueSuggest() {
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(runSuggest, SUGGEST_DEBOUNCE_MS);
  }

  function selectSuggestionIndex(index) {
    if (index < 0 || index >= suggestResults.length) return;
    const place = suggestResults[index];
    els.input.value = formatPlace(place);
    hideSuggestions();
    loadWeatherForPlace(place, { silent: false });
  }

  els.form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideSuggestions();
    const q = els.input.value;
    if (!q || !q.trim()) {
      showError("Enter a city, state, or country.");
      return;
    }
    search(q).catch(function (err) {
      els.weatherSection.hidden = true;
      els.emptyState.hidden = false;
      stopLiveUi();
      resetScene();
      showError(err instanceof Error ? err.message : "Something went wrong.");
    });
  });

  els.input.addEventListener("input", function () {
    hideError();
    queueSuggest();
  });

  els.input.addEventListener("focus", function () {
    if (els.input.value.trim().length >= SUGGEST_MIN_CHARS) queueSuggest();
  });

  els.input.addEventListener("blur", function () {
    setTimeout(hideSuggestions, 180);
  });

  els.suggestions.addEventListener("mousedown", function (e) {
    const li = e.target.closest(".suggestion-item");
    if (!li) return;
    e.preventDefault();
    const idx = parseInt(li.dataset.index, 10);
    selectSuggestionIndex(idx);
  });

  els.input.addEventListener("keydown", function (e) {
    if (els.suggestions.hidden || !suggestResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestHighlight = Math.min(suggestHighlight + 1, suggestResults.length - 1);
      highlightSuggestion(suggestHighlight);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestHighlight = Math.max(suggestHighlight - 1, 0);
      highlightSuggestion(suggestHighlight);
    } else if (e.key === "Enter" && suggestHighlight >= 0) {
      e.preventDefault();
      selectSuggestionIndex(suggestHighlight);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  els.btnCity.addEventListener("click", function () {
    els.input.focus();
    els.input.select();
    if (els.input.value.trim().length >= SUGGEST_MIN_CHARS) queueSuggest();
  });

  els.unitC.addEventListener("click", function () {
    setUnitFahrenheit(false);
  });
  els.unitF.addEventListener("click", function () {
    setUnitFahrenheit(true);
  });
})();
