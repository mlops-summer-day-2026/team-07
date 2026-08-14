(function (global) {
  "use strict";

  var TIMEZONE = "Europe/Moscow";
  var FETCH_TIMEOUT_MS = 12000;
  var CONCURRENCY = 2;
  var SLOT_PAUSE_MS = 350;

  var DEFAULT_SOURCES = [
    { name: "Lenta.ru", url: "https://lenta.ru/rss" },
    { name: "РИА Новости", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "ТАСС", url: "https://tass.ru/rss/v2.xml" },
    { name: "РБК", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Интерфакс", url: "https://www.interfax.ru/rss.asp" },
    { name: "Коммерсантъ", url: "https://www.kommersant.ru/RSS/news.xml" },
    { name: "Газета.ру", url: "https://www.gazeta.ru/export/rss/first.xml" },
  ];

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function moscowParts(date) {
    var fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    var parts = {};
    fmt.formatToParts(date).forEach(function (p) {
      if (p.type !== "literal") parts[p.type] = p.value;
    });
    return parts;
  }

  function moscowDateString(date) {
    var p = moscowParts(date);
    return p.year + "-" + p.month + "-" + p.day;
  }

  function moscowTimeString(date) {
    var p = moscowParts(date);
    return p.hour + ":" + p.minute;
  }

  function firstChildText(el, names) {
    if (!el) return "";
    for (var i = 0; i < names.length; i++) {
      var found = el.getElementsByTagName(names[i])[0];
      if (found && found.textContent) return found.textContent.trim();
    }
    return "";
  }

  function parseDate(raw) {
    if (!raw) return null;
    var d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
    var cleaned = raw.replace(/\s+/g, " ").trim();
    d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  function normalizeUrl(url) {
    if (!url) return "";
    try {
      var u = new URL(url.trim());
      u.hash = "";
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"].forEach(
        function (key) {
          u.searchParams.delete(key);
        }
      );
      var path = u.pathname.replace(/\/+$/, "");
      return (u.origin + path + u.search).toLowerCase();
    } catch (e) {
      return url.trim().toLowerCase();
    }
  }

  function normalizeTitle(title) {
    return (title || "")
      .toLowerCase()
      .replace(/[«»""„“]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeKeywords(keywords) {
    if (!keywords) return [];
    if (typeof keywords === "string") keywords = keywords.split(/[,;]+/);
    if (!Array.isArray(keywords)) return [];
    return keywords
      .map(function (k) {
        return String(k || "").trim();
      })
      .filter(Boolean);
  }

  function matchKeywords(title, keywords) {
    if (!keywords.length) return [];
    var hay = (title || "").toLowerCase();
    return keywords.filter(function (k) {
      return hay.indexOf(k.toLowerCase()) !== -1;
    });
  }

  function fetchWithTimeout(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    return fetch(url, { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error("HTTP " + res.status);
          err.status = res.status;
          throw err;
        }
        return res.text();
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function decodeAllOrigins(jsonText) {
    var data = JSON.parse(jsonText);
    var contents = data.contents || "";
    if (contents.indexOf("data:") === 0) {
      var b64 = contents.split(",")[1] || "";
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }
    return contents;
  }

  function itemsFromRss2Json(data) {
    if (!data || data.status !== "ok" || !Array.isArray(data.items)) {
      throw new Error((data && data.message) || "rss2json");
    }
    return data.items
      .map(function (it) {
        var published = parseDate(it.pubDate);
        return {
          title: it.title || "",
          url: (it.link || "").trim(),
          time: published ? moscowTimeString(published) : "",
          _publishedMs: published ? published.getTime() : 0,
          _date: published ? moscowDateString(published) : "",
        };
      })
      .filter(function (it) {
        return it.title || it.url;
      });
  }

  function fetchSourceItems(rssUrl) {
    var rss2 =
      "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(rssUrl);
    var allorigins =
      "https://api.allorigins.win/get?url=" + encodeURIComponent(rssUrl);

    return fetchWithTimeout(rss2)
      .then(function (text) {
        return itemsFromRss2Json(JSON.parse(text));
      })
      .catch(function () {
        return fetchWithTimeout(allorigins)
          .then(decodeAllOrigins)
          .then(parseRssItems);
      })
      .catch(function () {
        return fetchWithTimeout(rssUrl).then(parseRssItems);
      });
  }

  function parseRssItems(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("невалидный RSS");
    }

    var nodes = doc.getElementsByTagName("item");
    if (!nodes.length) nodes = doc.getElementsByTagName("entry");

    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var title = firstChildText(node, ["title"]);
      var link = firstChildText(node, ["link"]);
      if (!link) {
        var linkEl = node.getElementsByTagName("link")[0];
        if (linkEl) link = linkEl.getAttribute("href") || "";
      }
      var rawDate = firstChildText(node, ["pubDate", "published", "updated", "date"]);
      var published = parseDate(rawDate);
      if (!title && !link) continue;

      items.push({
        title: title,
        url: (link || "").trim(),
        time: published ? moscowTimeString(published) : "",
        _publishedMs: published ? published.getTime() : 0,
        _date: published ? moscowDateString(published) : "",
      });
    }
    return items;
  }

  function runPool(tasks, concurrency, pauseMs) {
    var results = new Array(tasks.length);
    var next = 0;

    function worker() {
      if (next >= tasks.length) return Promise.resolve();
      var index = next++;
      var started = Date.now();
      return Promise.resolve()
        .then(tasks[index])
        .then(function (value) {
          results[index] = { ok: true, value: value };
        })
        .catch(function (err) {
          results[index] = { ok: false, error: err };
        })
        .then(function () {
          var wait = pauseMs - (Date.now() - started);
          if (wait > 0 && next < tasks.length) return sleep(wait);
        })
        .then(worker);
    }

    var workers = [];
    var n = Math.min(concurrency, tasks.length);
    for (var i = 0; i < n; i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return results;
    });
  }

  function dedupeItems(items) {
    var byUrl = {};
    var unique = [];

    items.forEach(function (item) {
      var key = normalizeUrl(item.url);
      if (key) {
        if (byUrl[key]) return;
        byUrl[key] = true;
      }
      unique.push(item);
    });

    var byTitle = {};
    return unique.filter(function (item) {
      var key = normalizeTitle(item.title);
      if (!key) return true;
      if (byTitle[key]) return false;
      byTitle[key] = true;
      return true;
    });
  }

  /**
   * Собирает сегодняшние новости российских СМИ.
   *
   * @param {Object} [options]
   * @param {string[]|string} [options.keywords] ключевые слова; пусто = все новости за сегодня
   * @param {number} [options.maxItems=25]
   * @param {{name:string,url:string}[]} [options.sources]
   * @returns {Promise<Array<{title:string,url:string,time:string}>>}
   */
  function collectNews(options) {
    options = options || {};
    var keywords = normalizeKeywords(options.keywords);
    var maxItems = Number(options.maxItems);
    if (!maxItems || maxItems < 1) maxItems = 25;
    var sources = Array.isArray(options.sources) && options.sources.length
      ? options.sources
      : DEFAULT_SOURCES;

    var today = moscowDateString(new Date());

    var tasks = sources.map(function (source) {
      return function () {
        return fetchSourceItems(source.url);
      };
    });

    return runPool(tasks, CONCURRENCY, SLOT_PAUSE_MS).then(function (results) {
      var items = [];

      results.forEach(function (result) {
        if (!result.ok) return;
        items = items.concat(result.value);
      });

      var filtered = items.filter(function (item) {
        if (item._date !== today) return false;
        if (!keywords.length) return true;
        return matchKeywords(item.title, keywords).length > 0;
      });

      filtered.sort(function (a, b) {
        return b._publishedMs - a._publishedMs;
      });

      return dedupeItems(filtered).slice(0, maxItems).map(function (item) {
        return {
          title: item.title,
          url: item.url,
          time: item.time,
        };
      });
    });
  }

  global.collectNews = collectNews;
})(typeof window !== "undefined" ? window : globalThis);
