# Mealie planned meals

Connect **Meals → Mealie** on a parent's device. Mealie remains the place to plan meals and
store recipes. Kinwall shows dated meal-plan entries in Meals, on the Board and in daily
summaries, with a recipe link back to Mealie. It does not copy recipes, ingredients, instructions,
photos or shopping lists, and never sends changes back to Mealie.

## Connect

1. In Mealie, create a long-lived API token under your profile's API tokens page. Use a user
   belonging to the household whose meal plan you want to show.
2. Open **Meals → Mealie** in Kinwall. Enter the Mealie server address, without `/api` or `/g/...`.
   A deployment under a subpath can include that subpath.
3. Enter the group's URL name: in `https://mealie.example/g/home/r/pasta`, this is `home`.
   This controls recipe links; the API token determines the household being read.
4. Paste the token and choose **Save connection**, then **Sync now** to check the connection
   and refresh the dates currently visible in Meals.

The token is encrypted with Kinwall's `ENCRYPTION_KEY`, never returned to the browser, and
excluded from Kinwall exports. An empty token field keeps the saved token. Disconnect before
changing server or group. Disconnecting forgets the token and sync links but keeps imported
meals as ordinary Kinwall meals. Reconnecting imports a fresh set of linked meals.

Mealie's API documentation: [API usage](https://mealie.io/documentation/getting-started/api-usage/).
This integration uses `GET /api/households/mealplans`, with inclusive `start_date`/`end_date`
and numbered pagination, using the modern household API. It reads single-day entries; newer
week-wide entries are not requested. The group recipe route is `/g/<group>/r/<recipe-slug>`.

## What sync changes

* Each remote meal-plan entry has its own stable link, so repeated syncs do not duplicate it.
  Breakfast, lunch and dinner keep their slot; sides, snacks, drinks and desserts use Snack.
* Mealie controls the title, date, slot and recipe URL. Kinwall's cook, eaters, servings, notes,
  planned time and cooked status stay local. Local edits to Mealie-controlled fields are replaced
  at the next sync. Mealie notes and recipe serving sizes are not copied; adjust servings in Kinwall.
* A meal linked to a calendar event is pinned: sync leaves its fields unchanged to avoid silently
  moving the event. Unlink the event to resume updates from Mealie.
* If an entry disappears from the synced dates, its untouched planned meal is removed. Completed,
  annotated or calendar-linked meals, and meals with a local cook, eaters, changed servings or
  planned time, are kept and detached from sync. Other Kinwall meals and
  dates outside the sync window are untouched. Removing a linked meal in Kinwall alone allows it
  to be imported again while it still exists in Mealie.
* Sync fetches and validates all pages before changing meals, so provider errors and incomplete
  responses do not clear the plan. The token is never sent across redirects. One sync runs at a time.

Kinwall's scheduled task checks a rolling window from seven days ago through 35 days ahead,
using the family's time zone. Successful automatic checks are at least 15 minutes apart;
actual timing follows the host's sync/cron interval. **Sync now** uses the visible meal dates
instead (the API allows up to 91 inclusive days). Sync pauses while Meals is turned off.

A Mealie recipe link requires the reader's normal Mealie access. Kinwall does not pass its API
token in recipe links or bypass Mealie login or Cloudflare Access. Recipe ingredients remain
in Mealie, so Kinwall's grocery projection does not include these meals.

## Self-hosted Mealie on a private network

Public servers must use HTTPS. A self-hosted Kinwall can reach Mealie on its LAN by explicitly
setting `ALLOW_PRIVATE_MEALIE_URLS=1` in Kinwall's server environment and restarting it. This
also allows HTTP for that connection. Use the address reachable from the Kinwall container;
`localhost` refers to Kinwall's container, not the Raspberry Pi. Workers cannot reach your LAN.
The same address is used for recipe links, so it should also be reachable from the family devices.

## REST API

These endpoints require a parent/admin sign-in and reject paired displays and connected apps:

| Method | Endpoint | Body / result |
|---|---|---|
| GET | `/api/integrations/mealie` | `{connected,url,groupSlug,lastSyncedAt,lastError}`; no token |
| PUT | `/api/integrations/mealie` | `{url,groupSlug,token?}`; token required for first connection |
| POST | `/api/integrations/mealie/sync` | `{from,to}` → `{imported,removed}`; imported counts additions and updates |
| DELETE | `/api/integrations/mealie` | Disconnect, keep meals |

Connection changes and sync return `409` while a sync holds a lease. Provider/response failures
return a redacted `502`; check the URL, token, server availability and proxy rules. An invalid or
private URL without the explicit self-hosting opt-in returns `400`.
