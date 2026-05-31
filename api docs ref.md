# Ping API Reference

Comprehensive reference for integrating with the Ping platform. This spec is structured to be parsed into a developer portal (for example, Tailwind UI Protocol template). It includes auth models, headers, error contracts, rate limits, and detailed request/response examples.

## Environments

- Backend API base URL (production): ${API_BACKEND_URL}
- Dashboard application: ${APP_DASHBOARD_URL}
- Staging/local may vary per deployment. All examples below show relative paths.

## Versioning

- Current API prefix: v1 (e.g., /v1/auth/login)
- Backward compatibility: additive changes preferred. Breaking changes will bump the prefix (v2, etc.).

## Content and Conventions

- Content-Type: application/json unless specified.
- Character set: UTF-8.
- Dates/times:
  - Some generic endpoints (notably /v1/get/*) return human-readable dates like "dd/mm/YYYY" or "dd/mm/YYYY HH:MM". Those formats are documented per-endpoint.
  - Other endpoints return ISO 8601 UTC when explicitly stated.
- Identifiers:
  - public_id fields are UUID strings.
  - Numeric ids are database primary keys (integers).

## Authentication Models

Two primary auth methods exist. Choose the one that matches your integration.

1) User/Admin/Agent JWT
- Obtain with POST /v1/auth/login
- Send on subsequent requests via: Authorization: Bearer <accessToken>
- Tokens contain: { public_id, session_id, iat, exp }
- Token TTL: access 30 days; refresh 180 days.
- Header User-Type must match the actor: user | adminuser | agent.

2) API Key (Developer Notification APIs)
- Managed via API keys (visible in dashboard, masked after creation).
- Send on requests via: X-Ping-Api-Key: <key>
- Optionally set required permission per operation via X-Ping-Required-Permission: sms | email | whatsapp | templates | bulk

## Required Headers (Summary)

- Authorization: Bearer <jwt> (JWT-protected routes)
- User-Type: user | adminuser | agent (required for JWT routes)
- X-Business-Id: integer business id for business-scoped GET/POST/PUT/DELETE where not implied
- X-Ping-Api-Key: <api key> (developer APIs)
- X-Ping-Required-Permission: sms | email | whatsapp | templates | bulk (developer APIs; optional)
- Content-Type: application/json

## Rate Limiting

- Authentication endpoints: login 5/min, refresh 5/min, accept-invite 10/hour.
- Other endpoints may have defaults; exceeding limits returns 429 Too Many Requests.
- Best practice: implement exponential backoff on 429 and respect Retry-After if present.

## Error Model

All errors use a consistent envelope unless otherwise noted:

{
  "result": "failed",
  "message": "Human-readable error",
  "code": "OptionalMachineCode",
  "error_info": "Optional detailed info"
}

Common HTTP statuses: 400 (validation), 401 (auth), 403 (permission), 404 (missing), 409 (conflict), 429 (rate limit), 500 (server).

## Pagination & Filtering

- Generic list endpoints under /v1/get/{section} support:
  - skip (default 0), limit (default 50) via query params.
- Business-scoped lists require X-Business-Id unless the business id is in the path.
- Additional filters are endpoint-specific and documented below when available.

## Authentication

- POST /v1/auth/login
  - Headers: User-Type: user | adminuser | agent
  - Body:
    {
      "email": "user@example.com",
      "password": "secret123"
    }
  - Response (200):
    {
      "result": "success",
      "message": "You have successfully logged in!",
      "accessToken": "<jwt>",
      "refreshToken": "<jwt>",
      "user": {
        "public_id": "<uuid>",
        "first_name": "...",
        "last_name": "...",
        "email_address": "...",
        "phone_number": "..."
      },
      "businesses": [ { /* business objects */ } ]
    }

- POST /v1/auth/refresh
  - Body: { "refreshToken": "<jwt>", "userType": "user" }
  - Response (200): { "result": "success", "accessToken": "<jwt>" }

- POST /v1/auth/signup
  - Body (JSON or multipart/form-data): user fields plus optional business fields
  - Response (200): { "result": "success", "message": "Account created. Check your email to activate." }
  - Notes: Issues activation code and an activation JWT for one-click link. If business data provided, creates business and owner membership.

- GET /v1/auth/activate?token=JWT
  - Purpose: One‑click activation via email link.
  - Returns: HTML/JSON message, sets user active.

- POST /v1/auth/verifications/email-by-code
  - Body: { emailAddress, activationCode }
  - Returns: { result, message }

- POST /v1/auth/logout
  - Body: { email }
  - Returns: { result, message }

- POST /v1/auth/forgotPassword
  - Body: { email }
  - Returns: { result, message }

- POST /v1/auth/resetPassword
  - Body: { email, newPassword, resetToken (if applicable) }
  - Returns: { result, message }

### Invite flow

- POST /v1/add/user (invite mode)
  - Headers: Authorization: Bearer <jwt>, User-Type: user|adminuser|agent
  - Body: { isInvite: true, emailAddress, businessId, role }
  - Returns: { result, invite: { public_id, email, business_id, role, expires_at, is_accepted } }

- GET /v1/auth/validate-invite?token=RAW_TOKEN
  - Returns: { result, invite: { email, role, expires_at, business: { id, name } } }

- POST /v1/auth/accept-invite
  - Body: { inviteToken, email, password, firstName, lastName, city?, country?, physicalAddress? }
  - Returns: { result, message, user, business }
  - Notes:
    - Accepting an invite does NOT log the user in. After acceptance, the user must call /v1/auth/login to obtain a session token.
    - If a browser is currently authenticated as a different user, clear stored tokens before logging in as the invited user.

## Users and Membership

- POST /v1/add/{section}
  - section=user (direct create):
    - Headers: Authorization: Bearer <jwt>, User-Type
    - Body: { first_name, last_name, email_address, gender, city, physical_address, country }
    - Returns: { result, user }

- Membership management (scoped to business)
  - POST /{business_id}/members
    - Headers: Authorization: Bearer <jwt>
    - Body: { user_id, role }
  - PATCH /{business_id}/members/{user_id}/role
    - Body: { role }
  - DELETE /{business_id}/members/{user_id}

- Admin: update membership (role/active)
  - PUT /v1/admin/update/userBusiness/{membershipId}
  - Headers: Authorization: Bearer <admin JWT>, User-Type: adminuser
  - Body: { "role": "owner|admin|member|viewer", "is_active": true }
  - Response: { "result": "success", "message": "Membership successfully updated" }
  - Notes: {membershipId} is the numeric id from the user_business table. This changes a user’s role within a business or toggles active status.

- GET /v1/get/users/{businessId}
  - Purpose: Fetch business members and their user profiles, plus invites for the same business in a single call (useful for populating Users and Invites sections).
  - Headers:
    - Authorization: Bearer <jwt>
    - User-Type: user|adminuser|agent
  - Authorization: If User-Type is "user", the requester must be a member of the target business.
  - Returns:
    - result: "success"
    - message: summary
    - users: array of membership objects, each with top-level membership fields and a nested user object
      - membership fields (top-level for each item):
        - id, public_id, business_id, user_id, role, is_active, timezone, date_created, date_updated
      - user (nested; all available fields except password):
        - id, public_id, username, first_name, last_name, email_address, phone_number, gender, city, physical_address, country, is_admin, is_active, status, activation_code, timezone, date_created, date_updated
    - invites: array of invite objects for the same business
      - id, public_id, email, business_id, role, is_revoked, accepted_at, accepted_by_user_id, token_expires_at, created_by_user_id, status, date_created, date_updated
  - Notes:
    - status is computed based on invite fields: pending | accepted | revoked | expired.
    - Date fields in this response are formatted as dd/mm/YYYY or dd/mm/YYYY HH:MM.
  - Example response:
    ```json
    {
      "result": "success",
      "message": "Found 2 users and 1 invites",
      "users": [
        {
          "id": 31,
          "public_id": "3a4f2b3a-2c0b-4a0d-9a2f-1ed5e3e3a0b1",
          "business_id": 5,
          "user_id": 12,
          "role": "owner",
          "is_active": true,
          "timezone": "Africa/Harare",
          "date_created": "01/10/2025",
          "date_updated": "02/10/2025 10:15",
          "user": {
            "id": 12,
            "public_id": "a1b2c3d4-5678-4e90-abcd-ef1234567890",
            "username": "sam",
            "first_name": "Sam",
            "last_name": "Moyo",
            "email_address": "sam@example.com",
            "phone_number": "+263771234567",
            "gender": "male",
            "city": "Harare",
            "physical_address": "12 Jason Moyo Ave",
            "country": "ZW",
            "is_admin": false,
            "is_active": true,
            "status": "active",
            "activation_code": null,
            "timezone": "Africa/Harare",
            "date_created": "28/09/2025",
            "date_updated": "02/10/2025 09:00"
          }
        },
        {
          "id": 32,
          "public_id": "e7b55b77-9a70-4a16-a0f6-9a5a7bf2e4c3",
          "business_id": 5,
          "user_id": 18,
          "role": "admin",
          "is_active": true,
          "timezone": "Africa/Harare",
          "date_created": "03/10/2025",
          "date_updated": "03/10/2025 12:30",
          "user": {
            "id": 18,
            "public_id": "0f1e2d3c-4b5a-6978-90ab-cdef01234567",
            "username": "tari",
            "first_name": "Tariro",
            "last_name": "Ncube",
            "email_address": "tari@example.com",
            "phone_number": "+263781234567",
            "gender": "female",
            "city": "Bulawayo",
            "physical_address": "8 Leopold Takawira",
            "country": "ZW",
            "is_admin": false,
            "is_active": true,
            "status": "active",
            "activation_code": null,
            "timezone": "Africa/Harare",
            "date_created": "30/09/2025",
            "date_updated": "03/10/2025 12:00"
          }
        }
      ],
      "invites": [
        {
          "id": 44,
          "public_id": "9a8b7c6d-5e4f-4321-9abc-def012345678",
          "email": "new.user@example.com",
          "business_id": 5,
          "role": "user",
          "is_revoked": false,
          "accepted_at": null,
          "accepted_by_user_id": null,
          "token_expires_at": "08/10/2025 18:00",
          "created_by_user_id": 12,
          "status": "pending",
          "date_created": "01/10/2025",
          "date_updated": "01/10/2025 09:45"
        }
      ]
    }
    ```

## Business

- POST /v1/add/business
  - Headers: Authorization: Bearer <jwt>
  - Body: { name, business_type?, tag?, description?, address?, city?, country?, registration_number?, email_address?, phone_number?, website? }
  - Returns: { result, business: { id, public_id, name, status, creator_role } }

- GET /v1/get/business/{id}
  - Headers: Authorization: Bearer <jwt>
  - Returns: Business object

- GET /v1/get/businesses
  - Headers: Authorization: Bearer <jwt>
  - Returns: All businesses that the current user is a member of.

- PUT /v1/update/business/{id}
  - Headers: Authorization: Bearer <jwt>
  - Body: Partial business fields

- DELETE /v1/delete/business/{id}
  - Headers: Authorization: Bearer <jwt>

## Recipients and Groups

- POST /v1/add/recipient
  - Body: { first_name, last_name, email?, sms_phone?, whatsapp_phone?, street?, city?, state?, zip_code?, country?, tags?, notes? }
- POST /v1/add/recipientGroup
- POST /v1/recipients/groups/add (alias)
- POST /v1/add/recipientGroupMember
- GET /v1/get/recipient{, /recipient/{id}}
  - Headers: Authorization: Bearer <jwt>; X-Business-Id may be required
  - Query: skip, limit
  - Returns: recipients with formatted date fields; tags parsed to arrays when available
- PUT /v1/update/recipient/{id}
- DELETE /v1/delete/recipient/{id}

All above require Authorization and business scoping (X-Business-Id if needed).

## Notifications (User dashboard)

Base router: /v1/notification

- Templates
  - POST /v1/notification/templates
  - GET /v1/notification/templates
  - GET /v1/notification/templates/{template_id}
  - PUT /v1/notification/templates/{template_id}
  - DELETE /v1/notification/templates/{template_id}

- SMS
  - POST /v1/notification/sms/send
    - Body:
      {
        "sender": "Ping",
        "recipients": ["+263771234567"],
        "message": "Hello from Ping"
      }
    - Returns: { result, message, sms_notification_id or group id }
  - GET /v1/notification/sms/test
  - POST /v1/notification/sms/bulk

- WhatsApp
  - GET /v1/notification/whatsapp/test
  - POST /v1/notification/whatsapp/send
  - POST /v1/notification/whatsapp/bulk

- Email
  - GET /v1/notification/email/test
  - POST /v1/notification/email/send
    - Body:
      {
        "from": "no-reply@ping.co.zw",
        "to": ["alice@example.com"],
        "subject": "Welcome",
        "html": "<p>Hi Alice</p>",
        "templateId": "optional-template",
        "templateData": { "name": "Alice" }
      }
  - POST /v1/notification/email/bulk

- History & Analytics
  - GET /v1/notification/history/{notification_type}
  - GET /v1/notification/history/sms
  - GET /v1/notification/history/whatsapp
  - GET /v1/notification/history/email
  - GET /v1/notification/history/all
  - GET /v1/notification/bulk/{bulk_id}
  - GET /v1/notification/bulk
  - GET /v1/notification/analytics/summary

Headers: Authorization: Bearer <jwt>, X-Business-Id where required.

## Developer Notification APIs (API key auth)

Base router: /v1/notification/api
Headers:
- X-Ping-Api-Key: <api key>
- Optional: X-Ping-Required-Permission: sms|email|whatsapp|templates|bulk

- POST /v1/notification/api/sms/send
  - Headers:
    - X-Ping-Api-Key: <key>
    - X-Ping-Required-Permission: sms (optional)
  - Body:
    {
      "sender": "Ping",
      "recipients": ["+263771234567"],
      "message": "Hello"
    }
  - Response: { result, message, public_id or group id }
- POST /v1/notification/api/whatsapp/send
  - Body: { to_phone, message } OR { to_phone, template_name, template_data } OR { to_phone, interactive }
  - Interactive buttons: { type: "buttons", body: "...", buttons: [{id, title}], header?, footer? }
  - Interactive list: { type: "list", body: "...", button_text: "...", sections: [{title, rows: [{id, title, description?}]}], header?, footer? }
- POST /v1/notification/api/email/send
  - Headers: X-Ping-Api-Key; X-Ping-Required-Permission: email
  - Body:
    {
      "from": "no-reply@ping.co.zw",
      "to": ["alice@example.com"],
      "subject": "Welcome",
      "html": "<p>Hi Alice</p>"
    }
- GET /v1/notification/api/templates
- GET /v1/notification/api/bulk/{bulk_id}
- GET /v1/notification/api/history/{notification_type}

## Bulk Notification (alternate)

- POST /v1/notification/email/bulk
- GET /v1/notification/bulk
- GET /v1/notification/bulk/{bulk_id}

## Sender ID

Base: /v1/sender-id
- POST /v1/sender-id/{public_id}/status
- POST /v1/sender-id/{public_id}/default
- GET /v1/sender-id/default

## Billing

- GET /v1/billing/info
  - Headers: X-Ping-Api-Key or JWT + X-Business-Id
  - Returns usage snapshot and projected cost.

## Admin

Base: /v1/admin
- POST /v1/admin/add
- GET /v1/admin/get/{section}
- GET /v1/admin/get/{section}/{sectionId}
- PUT /v1/admin/update/{section}/{sectionId}
- DELETE /v1/admin/delete/{section}/{sectionId}
- API Keys:
  - POST /v1/admin/api-keys
  - GET /v1/admin/api-keys
  - GET /v1/admin/api-keys/{api_key_id}
  - PUT /v1/admin/api-keys/{api_key_id}
  - DELETE /v1/admin/api-keys/{api_key_id}

## Get/Update/Delete generic routes

- GET /v1/get/{section}
- GET /v1/get/{section}/{sectionId}
- PUT /v1/update/{section}/{sectionId}
- DELETE /v1/delete/{section}/{sectionId}

Supported sections (non-exhaustive):
- user (profile), users (by businessId), recipients, recipient, recipientGroups, recipientGroup, recipientsByGroup, recipientGroupMembers, recipientGroupMember, apiKeys, apiKey, businesses, business, businessKycDocuments, count/*

Examples:
- GET /v1/get/recipients?skip=0&limit=50 (requires X-Business-Id)
- GET /v1/get/recipient/{id}
- GET /v1/get/recipientGroups (requires X-Business-Id)
- GET /v1/get/count/customers/{business_id}
- GET /v1/get/count/transactions/{business_id}

Notes:
- Business-scoped sections require X-Business-Id unless the business id is provided in the path.
- Count endpoints also support: /v1/get/count/customers and /v1/get/count/transactions using the X-Business-Id header.

## Required headers summary

- JWT user/admin/agent endpoints:
  - Authorization: Bearer <token>
  - User-Type: user|adminuser|agent
  - X-Business-Id: when the selected section is business-scoped and not otherwise inferred

- API key endpoints:
  - X-Ping-Api-Key: <api key>
  - Optional: X-Ping-Required-Permission

## Common error responses

- 400 Bad Request: Missing/invalid fields
- 401 Unauthorized: Missing/invalid credentials
- 403 Forbidden: Not a member of the target business / insufficient permission
- 404 Not Found: Resource missing, invalid token
- 409 Conflict: Duplicate resource, duplicate invite
- 429 Too Many Requests: Rate limited
- 500 Internal Server Error

## Changelog highlights

- Invites: Secure flow added — persisted token hash with 7‑day expiry, validate and accept endpoints, email with business name and correct domain.
- API keys: Hashing, masking, usage metrics; developer endpoints expect X-Ping-Api-Key.

## Security & Best Practices

- Always scope requests to a business where applicable using X-Business-Id to avoid cross-tenant leakage.
- Never store or log full API keys. The platform only displays full key value at creation time; subsequent reads return masked values.
- Handle 401/403 distinctly: 401 indicates missing/expired token or key; 403 indicates insufficient permission or not a member of the target business.
- Implement retries with backoff on 429 and idempotent operations where applicable. Explicit idempotency keys are not yet supported.

## Support

- Technical support email: ${EMAIL_CONFIG_TECH_SUPPORT_EMAIL}
- Monitoring/health: operational runbooks are available in docs/OPERATIONS.md

---
Swagger/OpenAPI docs are also available at the configured docs URL (see `app/api.py`). If you need a Postman collection or client SDKs, we can generate them on request.

---
If you want this reference in OpenAPI/Swagger too, the service already exposes docs at the configured docs URL (see `app/api.py` docs_url). I can also generate a static OpenAPI JSON and a Postman collection on request.
