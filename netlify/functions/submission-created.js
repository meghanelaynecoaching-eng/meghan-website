// Netlify Function: runs automatically whenever a Netlify Form is submitted.
// It adds the person to Flodesk and drops them into the matching segment.
//
// SETUP:
//   In Netlify, add an environment variable:  FLODESK_API_KEY = <your key>
//
// Each form on the site declares its Flodesk segment in a hidden "segment"
// field, and the code looks that segment up by name, so you never need a
// segment ID. If you ever add a new segment for the Find Your Fit / service
// enquiry options, add a line to ANSWER_TO_SEGMENT below.

const FLODESK_API = "https://api.flodesk.com/v1";

// Each form carries its Flodesk segment name in a hidden "segment" field,
// so routing never depends on the form's label. The only special cases are
// Find Your Fit and the service enquiry, which pick a segment based on the
// option the person selected. That mapping lives here:
const ANSWER_TO_SEGMENT = {
  "1:1 Private Coaching":    "Inquiry: Private Coaching",
  "Nutrition Strategy Call": "Inquiry: Nutrition Strategy Call",
  "In-Person Training":      "Inquiry: In Person Training",
  "Custom Training Program": "Inquiry: Custom Training",
  "Not sure":                "Inquiry: Find Your Fit",
};
// -----------------------------------------------------------------------

function authHeader(key) {
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

function pick(data, names) {
  for (const n of names) {
    if (data[n] !== undefined && data[n] !== null && String(data[n]).trim() !== "") {
      return String(data[n]).trim();
    }
  }
  return "";
}

// Which segment NAME does this submission belong to?
function resolveSegmentName(data) {
  // If the person picked a specific support/service option, that wins.
  const answer = pick(data, ["support", "interest"]);
  if (answer && ANSWER_TO_SEGMENT[answer]) return ANSWER_TO_SEGMENT[answer];
  // Otherwise use the segment the form declares in its hidden "segment" field.
  return pick(data, ["segment"]);
}

// Fetch all segments once and build a name -> id lookup (case-insensitive).
async function fetchSegmentIndex(headers) {
  const idx = {};
  try {
    const res = await fetch(FLODESK_API + "/segments?per_page=100", { headers });
    if (!res.ok) {
      console.error("Flodesk list-segments failed:", res.status, await res.text());
      return idx;
    }
    const json = await res.json();
    const items = json.data || json.segments || (Array.isArray(json) ? json : []);
    items.forEach((s) => {
      if (s && s.name) idx[String(s.name).trim().toLowerCase()] = s.id;
    });
  } catch (e) {
    console.error("Flodesk list-segments error:", e);
  }
  return idx;
}

exports.handler = async (event) => {
  const apiKey = process.env.FLODESK_API_KEY;
  if (!apiKey) {
    console.error("FLODESK_API_KEY is not set in Netlify environment variables.");
    return { statusCode: 200, body: "No API key configured; skipped." };
  }

  let data = {};
  let formName = "";
  try {
    const parsed = JSON.parse(event.body || "{}");
    const payload = parsed.payload || parsed;
    data = payload.data || {};
    formName = payload.form_name || data["form-name"] || "";
  } catch (e) {
    console.error("Could not parse submission body:", e);
    return { statusCode: 200, body: "Bad payload; skipped." };
  }

  const email = pick(data, ["email", "Email", "email_address"]);
  const firstName = pick(data, ["first_name", "First name", "full_name", "name"]);
  if (!email) {
    console.error("Submission had no email; skipping Flodesk.", formName);
    return { statusCode: 200, body: "No email; skipped." };
  }

  const headers = {
    "Authorization": authHeader(apiKey),
    "Content-Type": "application/json",
    "User-Agent": "MeghanElayneCoaching (hello@meghanelaynecoaching.com)",
  };

  try {
    // 1) Create or update the subscriber (upserts by email).
    //    Flodesk returns the subscriber object, including its internal id,
    //    which the segment step below requires.
    const body = { email };
    if (firstName) body.first_name = firstName;

    let subscriberId = "";
    const upsert = await fetch(FLODESK_API + "/subscribers", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (upsert.ok) {
      const created = await upsert.json().catch(() => ({}));
      subscriberId = created && created.id ? created.id : "";
    } else {
      console.error("Flodesk subscriber upsert failed:", upsert.status, await upsert.text());
    }

    // 2) Add them to the right segment, using the subscriber's ID (not email).
    const targetName = resolveSegmentName(data);
    if (targetName && subscriberId) {
      const index = await fetchSegmentIndex(headers);
      const segmentId = index[targetName.trim().toLowerCase()];
      if (segmentId) {
        const seg = await fetch(
          FLODESK_API + "/subscribers/" + encodeURIComponent(subscriberId) + "/segments",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ segment_ids: [segmentId] }),
          }
        );
        if (!seg.ok) {
          console.error("Flodesk add-to-segment failed:", seg.status, await seg.text());
        }
      } else {
        console.error(
          'No Flodesk segment named "' + targetName + '" was found. ' +
          "Check the spelling in the SEGMENTS map matches Flodesk exactly."
        );
      }
    } else if (targetName && !subscriberId) {
      console.error("Could not read the Flodesk subscriber id; segment step skipped.");
    } else {
      console.log("No segment mapped for form:", formName);
    }
  } catch (err) {
    console.error("Flodesk request error:", err);
  }

  // Always return 200 so Netlify doesn't retry and the visitor never sees an error.
  return { statusCode: 200, body: "ok" };
};
