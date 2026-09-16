# Newsfeed Module

Source: [Modules — Newsfeed](https://docs.magicmirror.builders/modules/newsfeed.html).

```js
{
  module: "newsfeed",
  position: "bottom_bar",
  config: {
    feeds: [
      { title: "New York Times", url: "https://www.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
      { title: "BBC", url: "https://feeds.bbci.co.uk/news/video_and_audio/news_front_page/rss.xml?edition=uk" },
    ],
  },
}
```

## Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `feeds` | array | NYT homepage feed | See feed-object fields below |
| `showAsList` | boolean | `false` | |
| `showSourceTitle` | boolean | `true` | |
| `showPublishDate` | boolean | `true` | |
| `broadcastNewsFeeds` | boolean | `true` | Broadcast via `sendNotification()` |
| `broadcastNewsUpdates` | boolean | `true` | |
| `showDescription` | boolean | `false` | |
| `showTitleAsUrl` | boolean | `false` | Title becomes a link to the article |
| `wrapTitle` / `wrapDescription` | boolean | `true` | |
| `truncDescription` | boolean | `true` | |
| `lengthDescription` | 1–500 | `400` | Characters kept when truncated |
| `hideLoading` | boolean | `false` | Hide module instead of showing a loading state |
| `reloadInterval` | ms | `300000` (5 min) | How often feed content is re-fetched |
| `updateInterval` | ms | `10000` | How often the displayed headline rotates |
| `animationSpeed` | ms | `2500` | |
| `maxNewsItems` | number | `0` (unlimited) | Total items to cycle through |
| `ignoreOldItems` | boolean | `false` | |
| `ignoreOlderThan` | ms | `86400000` (1 day) | Age threshold for "old" |
| `removeStartTags` / `removeEndTags` | `'title'`, `'description'`, `'both'` | — | |
| `startTags` / `endTags` | array | — | Tags to strip |
| `prohibitedWords` | array | — | Drop any item whose title contains one of these |
| `scrollLength` | number | `500` | Pixels scrolled per "more details" step in full-article view |
| `logFeedWarnings` | boolean | `false` | |
| `allowedBasicHtmlTags` | array | `[]` | Strict allowlist of inline HTML tags to preserve |

## Feed object (`feeds[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | No | Shown above that source's items |
| `url` | string | **Yes** | |
| `encoding` | string | No | Default `UTF-8` |
| `useCorsProxy` | boolean | No | Default `true` — see the `mm-config` skill for what the CORS proxy is and that it's disabled by default at the server level as of 2.35.0 |
| `ignoreOldItems` / `ignoreOlderThan` | — | No | Per-feed override of the module-level setting |

## Notifications — incoming (control the module)

| Notification | Effect |
|---|---|
| `ARTICLE_NEXT` / `ARTICLE_PREVIOUS` | Step through headlines |
| `ARTICLE_MORE_DETAILS` | 1st call: show description. 2nd: full article in an iframe. 3rd+: reload + scroll by `scrollLength` |
| `ARTICLE_LESS_DETAILS` | Collapse back to title-only |
| `ARTICLE_TOGGLE_FULL` | Toggle fullscreen article view |
| `ARTICLE_INFO_REQUEST` | Module replies with `ARTICLE_INFO_RESPONSE` (title, source, date, desc, url) |

```js
this.sendNotification("ARTICLE_NEXT");
```

## Notifications — outgoing

| Notification | Payload |
|---|---|
| `NEWS_FEED` | Current list of news items |
| `NEWS_FEED_UPDATE` | Updated list, on refresh |
