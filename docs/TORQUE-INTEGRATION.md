# Torque CRM integration

**Status: NOT CONNECTED.** Torque's API/webhook documentation and credentials were not available when this was built, so nothing has been tested against Torque. The website side is complete: every lead is stored, queued, signed and delivered (with retries) as soon as an endpoint is configured.

## What you need to provide

| Variable | Purpose |
|---|---|
| `TORQUE_WEBHOOK_URL` | HTTPS endpoint in Torque that accepts a JSON `POST` for a new lead |
| `TORQUE_API_KEY` | sent as `Authorization: Bearer …` (optional if you rely on the signature) |
| `TORQUE_SIGNING_SECRET` | shared secret for the request signature (recommended) |
| `TORQUE_ASSIGNEE` | defaults to `Byron Green` |
| `NOTIFY_WEBHOOK_URL` | optional: any relay that turns `{ "text": "…" }` into an instant SMS/push |

Credentials live only in server environment variables; none reach the browser.

## Request

```
POST {TORQUE_WEBHOOK_URL}
Content-Type: application/json
Authorization: Bearer {TORQUE_API_KEY}
Idempotency-Key: rwb-lead-123
X-RWB-Timestamp: 1794440000
X-RWB-Signature: sha256=HMAC_SHA256(secret, "{timestamp}.{raw body}")
```

```json
{
  "event": "lead.created",
  "idempotency_key": "rwb-lead-123",
  "occurred_at": "2026-11-11T22:40:00.000Z",
  "contact": { "name": "Pat Rider", "phone": "+12565550142", "phone_display": "(256) 555-0142",
               "email": "pat@example.com", "dedupe_key": "9f2c…", "match_on": ["phone", "email"] },
  "inquiry": { "type": "quote", "label": "Get My Best Quote", "message": "Trade?", "preferred_time": null },
  "vehicle": { "description": "2026 Polaris Ranger Crew XP 1000", "stock_number": "R12345",
               "url": "https://www.ridewithbyron.com/inventory/…", "source_guid": "…",
               "location": "Shoals Outdoor Sports - Florence" },
  "attribution": { "source": "Facebook Ads", "utm_source": "facebook", "utm_medium": "paid_social",
                   "utm_campaign": "ranger-nov", "fbclid": "…", "referrer": "…", "landing_page": "/…", "first_seen": "…" },
  "assignment": { "assigned_to": "Byron Green", "notify_immediately": true },
  "follow_up_task": { "create": true, "title": "Follow up: Pat Rider — Get My Best Quote — 2026 Polaris Ranger…", "due_in_minutes": 15 },
  "consent": { "text": "By submitting, I agree…", "captured_at": "…" },
  "origin": { "site": "RideWithByron.com", "page": "/inventory/…", "lead_id": 123 }
}
```

`inquiry.type` is one of `quote`, `availability`, `visit`, `financing`, `question`, `text`.

## What Torque should do with it

1. **Create or update** the contact — match on `contact.phone` (E.164), then `email`. `dedupe_key` is a stable hash of the phone number.
2. Attach `vehicle` (stock number) and `inquiry` to the contact as a new activity.
3. Store `attribution.source` as the original lead source — only if the contact has none yet.
4. Assign to `assignment.assigned_to` and notify.
5. Create the follow-up task when `follow_up_task.create` is true.
6. Treat a repeated `Idempotency-Key` as already processed.
7. Respond `2xx`. If the JSON response has `id`, `contact_id` or `lead_id`, it is saved as the Torque reference.

## Delivery guarantees

* Leads are written to the site's database first, then delivered; a Torque outage never loses a lead.
* Non-2xx or timeout → retried with exponential backoff (2, 4, 8 … minutes, capped at 6 h, 20 attempts), then marked `failed` and shown in the dashboard.
* Leads captured before Torque is configured are marked `not configured` and are sent automatically once it is.
* Double-submits (same phone, same unit, same intent within 10 minutes) are collapsed before they reach Torque.

## Connecting and verifying

1. Set the variables and restart.
2. Admin → Leads → **Send test lead to Torque**. The dashboard reports the real HTTP result.
3. Confirm in Torque: contact created, vehicle attached, source saved, task created, notification received.
4. Submit the same phone again and confirm Torque updated the contact rather than duplicating it.

If Torque exposes a REST API rather than an inbound webhook, only `deliverLead()` in `src/leads.js` needs adapting (one function, ~25 lines).
