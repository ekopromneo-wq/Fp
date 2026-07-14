import { query } from './db.js';
import { getAuthUser, getUserBitrixConfig, requireAuth } from './auth.js';
import { fetchBitrixUsers } from './bitrix.js';

function mapContact(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    organization: row.organization,
    position: row.position,
    email: row.email,
    phone: row.phone,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listContacts(ownerId) {
  const result = await query('select * from contacts where owner_id = $1 order by name asc', [ownerId]);
  return result.rows.map(mapContact);
}

async function findDuplicate(ownerId, name, email) {
  if (email) {
    const byEmail = await query('select * from contacts where owner_id = $1 and lower(email) = lower($2) limit 1', [ownerId, email]);
    if (byEmail.rowCount > 0) {
      return byEmail.rows[0];
    }
  }

  const byName = await query('select * from contacts where owner_id = $1 and lower(name) = lower($2) limit 1', [ownerId, name]);
  return byName.rows[0] || null;
}

// Duplicate handling is interactive here (one contact at a time, from the
// manual "add contact" form) - a likely-duplicate is reported back instead
// of silently created, and the caller re-submits with mergeIntoId (update
// the existing row) or confirmDuplicate (create a distinct one anyway, e.g.
// two real people who happen to share a name) to proceed. Bulk import
// (importContactsFromCsv/VCard/Bitrix below) uses a different, non-
// interactive policy - see their own comments.
export async function createContact(ownerId, input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';

  if (!name) {
    throw new Error('Contact name is required');
  }

  const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null;
  const organization = typeof input.organization === 'string' && input.organization.trim() ? input.organization.trim() : null;
  const position = typeof input.position === 'string' && input.position.trim() ? input.position.trim() : null;
  const phone = typeof input.phone === 'string' && input.phone.trim() ? input.phone.trim() : null;
  const source = typeof input.source === 'string' && input.source ? input.source : 'manual';

  if (input.mergeIntoId) {
    const result = await query(
      `
        update contacts
        set name = $3, organization = $4, position = $5, email = $6, phone = $7, updated_at = now()
        where id = $1 and owner_id = $2
        returning *
      `,
      [input.mergeIntoId, ownerId, name, organization, position, email, phone],
    );

    return result.rowCount ? { contact: mapContact(result.rows[0]), duplicate: null } : { contact: null, duplicate: null };
  }

  if (!input.confirmDuplicate) {
    const duplicate = await findDuplicate(ownerId, name, email);

    if (duplicate) {
      return { contact: null, duplicate: mapContact(duplicate) };
    }
  }

  const result = await query(
    `
      insert into contacts (owner_id, name, organization, position, email, phone, source)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning *
    `,
    [ownerId, name, organization, position, email, phone, source],
  );

  return { contact: mapContact(result.rows[0]), duplicate: null };
}

export async function updateContact(id, ownerId, input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const hasName = Object.prototype.hasOwnProperty.call(data, 'name');
  const hasOrganization = Object.prototype.hasOwnProperty.call(data, 'organization');
  const hasPosition = Object.prototype.hasOwnProperty.call(data, 'position');
  const hasEmail = Object.prototype.hasOwnProperty.call(data, 'email');
  const hasPhone = Object.prototype.hasOwnProperty.call(data, 'phone');

  const existing = await query('select * from contacts where id = $1 and owner_id = $2', [id, ownerId]);

  if (existing.rowCount === 0) {
    return null;
  }

  const current = existing.rows[0];
  const name = hasName && typeof data.name === 'string' && data.name.trim() ? data.name.trim() : current.name;
  const organization = hasOrganization ? (typeof data.organization === 'string' && data.organization.trim() ? data.organization.trim() : null) : current.organization;
  const position = hasPosition ? (typeof data.position === 'string' && data.position.trim() ? data.position.trim() : null) : current.position;
  const email = hasEmail ? (typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null) : current.email;
  const phone = hasPhone ? (typeof data.phone === 'string' && data.phone.trim() ? data.phone.trim() : null) : current.phone;

  const result = await query(
    `
      update contacts
      set name = $3, organization = $4, position = $5, email = $6, phone = $7, updated_at = now()
      where id = $1 and owner_id = $2
      returning *
    `,
    [id, ownerId, name, organization, position, email, phone],
  );

  return mapContact(result.rows[0]);
}

export async function deleteContact(id, ownerId) {
  const result = await query('delete from contacts where id = $1 and owner_id = $2', [id, ownerId]);
  return result.rowCount > 0;
}

// --- CSV import -------------------------------------------------------

const CSV_COLUMN_ALIASES = {
  name: ['name', 'full name', 'fullname', 'имя', 'фио', 'название'],
  email: ['email', 'e-mail', 'почта'],
  organization: ['organization', 'company', 'организация', 'компания'],
  position: ['position', 'title', 'должность'],
  phone: ['phone', 'телефон', 'phone number'],
};

// Hand-rolled rather than a dependency - covers the common case (quoted
// fields with embedded commas/escaped quotes, CRLF or LF line endings) that
// a typical Google/Outlook contacts export produces, not the full RFC4180
// edge-case surface.
function parseCsvLines(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\r') {
      // skip - \n (or end of input) closes the row
    } else if (char === '\n') {
      pushRow();
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    pushRow();
  }

  return rows.filter((r) => r.some((cell) => cell.trim()));
}

function findColumnIndex(header, aliases) {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  return normalized.findIndex((cell) => aliases.includes(cell));
}

export function parseContactsCsv(text) {
  const rows = parseCsvLines(String(text || ''));

  if (rows.length === 0) {
    return [];
  }

  const [header, ...dataRows] = rows;
  const columns = Object.fromEntries(
    Object.entries(CSV_COLUMN_ALIASES).map(([field, aliases]) => [field, findColumnIndex(header, aliases)]),
  );

  return dataRows
    .map((row) => ({
      name: columns.name >= 0 ? (row[columns.name] || '').trim() : '',
      email: columns.email >= 0 ? (row[columns.email] || '').trim() : '',
      organization: columns.organization >= 0 ? (row[columns.organization] || '').trim() : '',
      position: columns.position >= 0 ? (row[columns.position] || '').trim() : '',
      phone: columns.phone >= 0 ? (row[columns.phone] || '').trim() : '',
    }))
    .filter((contact) => contact.name);
}

// --- vCard import -------------------------------------------------------

// Basic vCard 3.0/4.0 line fields only (FN/EMAIL/ORG/TITLE/TEL) - no
// nested/base64/photo properties, no line folding beyond the simple case.
export function parseContactsVCard(text) {
  const contacts = [];
  let current = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();

    if (/^BEGIN:VCARD$/i.test(line)) {
      current = { name: '', email: '', organization: '', position: '', phone: '' };
      continue;
    }

    if (/^END:VCARD$/i.test(line)) {
      if (current?.name) {
        contacts.push(current);
      }
      current = null;
      continue;
    }

    if (!current) {
      continue;
    }

    const separatorIndex = line.indexOf(':');

    if (separatorIndex === -1) {
      continue;
    }

    const rawKey = line.slice(0, separatorIndex).split(';')[0].toUpperCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (rawKey === 'FN') {
      current.name = value;
    } else if (rawKey === 'EMAIL' && !current.email) {
      current.email = value;
    } else if (rawKey === 'ORG' && !current.organization) {
      current.organization = value.split(';')[0];
    } else if (rawKey === 'TITLE' && !current.position) {
      current.position = value;
    } else if (rawKey === 'TEL' && !current.phone) {
      current.phone = value;
    }
  }

  return contacts.filter((contact) => contact.name);
}

// Bulk import (CSV/vCard/Bitrix) can't interactively ask "merge?" per row
// the way the single-contact form does - hundreds of rows would mean
// hundreds of prompts. Policy instead: an exact email match is treated as
// "already imported" and silently skipped; a name-only match (no email, so
// less certain) is reported back as `ambiguous` for the user to resolve
// individually via the normal POST /api/contacts flow, which already has
// the interactive dup-check.
async function bulkImportContacts(ownerId, parsedContacts, source) {
  let imported = 0;
  let skipped = 0;
  const ambiguous = [];

  for (const parsed of parsedContacts) {
    const duplicate = await findDuplicate(ownerId, parsed.name, parsed.email || null);

    if (duplicate && parsed.email && duplicate.email && duplicate.email.toLowerCase() === parsed.email.toLowerCase()) {
      skipped += 1;
      continue;
    }

    if (duplicate) {
      ambiguous.push({ parsed, existing: mapContact(duplicate) });
      continue;
    }

    await query(
      `
        insert into contacts (owner_id, name, organization, position, email, phone, source)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [ownerId, parsed.name, parsed.organization || null, parsed.position || null, parsed.email || null, parsed.phone || null, source],
    );
    imported += 1;
  }

  return { imported, skipped, ambiguous };
}

export async function importContactsFromCsv(ownerId, text) {
  return bulkImportContacts(ownerId, parseContactsCsv(text), 'csv');
}

export async function importContactsFromVCard(ownerId, text) {
  return bulkImportContacts(ownerId, parseContactsVCard(text), 'vcard');
}

// Idempotent on repeat imports (unlike CSV/vCard) - keyed on the Bitrix
// user's own id via `external_id`, so re-running this doesn't create
// duplicates the way a second identical CSV upload might.
export async function importContactsFromBitrix(ownerId) {
  const bitrixConfig = (await getUserBitrixConfig(ownerId)) || {};
  const users = await fetchBitrixUsers(bitrixConfig);
  let imported = 0;
  let updated = 0;

  for (const user of users) {
    const name = [user.lastName, user.firstName, user.secondName].filter(Boolean).join(' ');

    if (!name) {
      continue;
    }

    const existing = await query("select id from contacts where owner_id = $1 and source = 'bitrix' and external_id = $2", [
      ownerId,
      user.id,
    ]);

    if (existing.rowCount > 0) {
      await query('update contacts set name = $3, email = $4, updated_at = now() where id = $1 and owner_id = $2', [
        existing.rows[0].id,
        ownerId,
        name,
        user.email || null,
      ]);
      updated += 1;
    } else {
      await query(
        `
          insert into contacts (owner_id, name, email, source, external_id)
          values ($1, $2, $3, 'bitrix', $4)
        `,
        [ownerId, name, user.email || null, user.id],
      );
      imported += 1;
    }
  }

  return { imported, updated };
}

// --- matching contacts to a recording's diarized speakers ---------------

function normalizeNamePart(value) {
  return String(value || '').trim().toLowerCase();
}

// Same spirit as bitrix.js's matchSpeakerToBitrixUsers, but contacts only
// have one flat `name` field (not structured last/first/patronymic), so the
// match rule is "at least 2 shared words" instead of "2 of 3 structured
// fields" - same false-positive protection (a single shared first name
// isn't enough), adapted to the simpler shape.
export function matchSpeakerToContacts(speakerName, contacts) {
  const speakerWords = new Set(String(speakerName || '').split(/\s+/).map(normalizeNamePart).filter(Boolean));

  if (speakerWords.size < 2) {
    return [];
  }

  const candidates = [];

  for (const contact of contacts) {
    const contactWords = String(contact.name || '').split(/\s+/).map(normalizeNamePart).filter(Boolean);
    const matchedWordCount = contactWords.filter((word) => speakerWords.has(word)).length;

    if (matchedWordCount >= 2) {
      candidates.push({ id: contact.id, name: contact.name, email: contact.email, matchedWordCount });
    }
  }

  return candidates.sort((a, b) => b.matchedWordCount - a.matchedWordCount);
}

export async function matchRecordingSpeakersToContacts(recordingId, ownerId, speakers) {
  const contacts = await listContacts(ownerId);

  return speakers.map((speaker) => {
    const candidates = matchSpeakerToContacts(speaker.displayName, contacts);

    return {
      label: speaker.label,
      candidates,
      autoMatch: candidates.length === 1 ? candidates[0] : null,
    };
  });
}

export function registerContactRoutes(app) {
  app.get('/api/contacts', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const contacts = await listContacts(user.id);
    return c.json({ contacts });
  });

  app.post('/api/contacts', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await createContact(user.id, body);
      return c.json(result, result.contact ? 201 : 200);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to create contact' }, 400);
    }
  });

  app.patch('/api/contacts/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const contact = await updateContact(c.req.param('id'), user.id, body);

      if (!contact) {
        return c.json({ error: 'Contact not found' }, 404);
      }

      return c.json({ contact });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update contact' }, 400);
    }
  });

  app.delete('/api/contacts/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteContact(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    return c.json({ ok: true });
  });

  app.post('/api/contacts/import/csv', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const text = await c.req.text();

    try {
      const result = await importContactsFromCsv(user.id, text);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to import CSV' }, 400);
    }
  });

  app.post('/api/contacts/import/vcard', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const text = await c.req.text();

    try {
      const result = await importContactsFromVCard(user.id, text);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to import vCard' }, 400);
    }
  });

  app.post('/api/contacts/import/bitrix', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const result = await importContactsFromBitrix(user.id);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to import from Bitrix24' }, 400);
    }
  });
}
