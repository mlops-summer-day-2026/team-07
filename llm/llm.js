(function (global) {
  "use strict";

  var MODEL = "google/gemini-2.5-flash";

  var NEWS_PROMPT =
    "Ты редактор сводки дня. На входе JSON-массив новостей за сегодня: title, url, time. " +
    "Выбери важное и не очень. Для каждой новости укажи источник (url). Не выдумывай факты и ссылки. " +
    "Ответь только JSON без markdown: {\"important\":[{\"title\",\"why\",\"url\"}],\"other\":[{\"title\",\"url\"}]}";

  var MAIL_PROMPT =
    "Ты ассистент по почте. На входе JSON-массив писем за сегодня. " +
    "Выбери важное и не очень. Кратко объясни, почему письмо важное. Не выдумывай писем. " +
    "Ответь только JSON без markdown: {\"important\":[{\"title\",\"why\",\"url\"}],\"other\":[{\"title\",\"url\"}]}. url можно опустить.";

  var CALENDAR_PROMPT =
    "Ты ассистент по календарю. На входе JSON-массив встреч за сегодня. " +
    "Выбери важное и не очень. Кратко объясни, почему встреча важная. Не выдумывай событий. " +
    "Ответь только JSON без markdown: {\"important\":[{\"title\",\"why\",\"url\"}],\"other\":[{\"title\",\"url\"}]}. url можно опустить.";

  function emptyResult() {
    return { important: [], other: [] };
  }

  function getKey() {
    var key = global.OPENROUTER_API_KEY && String(global.OPENROUTER_API_KEY).trim();
    if (!key) throw new Error("Нет OPENROUTER_API_KEY в llm/constants.js");
    return key;
  }

  function parseLlmJson(text) {
    if (!text) throw new Error("пустой ответ LLM");
    var cleaned = String(text).trim();
    var fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) cleaned = fence[1].trim();
    var parsed = JSON.parse(cleaned);
    return {
      important: Array.isArray(parsed.important) ? parsed.important : [],
      other: Array.isArray(parsed.other) ? parsed.other : [],
    };
  }

  function openRouterUrls() {
    var direct = "https://openrouter.ai/api/v1/chat/completions";
    return [direct, "https://corsproxy.io/?" + encodeURIComponent(direct)];
  }

  function postOpenRouter(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + getKey(),
        "Content-Type": "application/json",
        "HTTP-Referer": (global.location && global.location.origin) || "",
        "X-Title": "team-07",
      },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var msg =
            (body && body.error && body.error.message) || "HTTP " + res.status;
          throw new Error(msg);
        }
        var choice = body.choices && body.choices[0] && body.choices[0].message;
        return parseLlmJson(choice && choice.content);
      });
    });
  }

  function askOpenRouter(systemPrompt, data) {
    var payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(data) },
      ],
    };
    var urls = openRouterUrls();

    function tryUrl(index) {
      return postOpenRouter(urls[index], payload).catch(function (err) {
        if (index + 1 >= urls.length) throw err;
        return tryUrl(index + 1);
      });
    }

    return tryUrl(0);
  }

  function summarize(prompt, items) {
    if (!items || !items.length) return Promise.resolve(emptyResult());
    return askOpenRouter(prompt, items);
  }

  function summarizeNews(items) {
    return summarize(NEWS_PROMPT, items);
  }

  function summarizeMail(letters) {
    return summarize(MAIL_PROMPT, letters);
  }

  function summarizeCalendar(events) {
    return summarize(CALENDAR_PROMPT, events);
  }

  global.summarizeNews = summarizeNews;
  global.summarizeMail = summarizeMail;
  global.summarizeCalendar = summarizeCalendar;
})(typeof window !== "undefined" ? window : globalThis);
