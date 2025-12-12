const DEFAULT_BASE_URL = 'https://api.typegpt.net/v1';
const DEFAULT_MODEL = 'moonshotai/kimi-k2-thinking';

function tryParseJson(text) {
    if (!text || typeof text !== 'string') return null;

    const trimmed = text.trim();

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenced ? fenced[1] : trimmed).trim();

    try {
        return JSON.parse(candidate);
    } catch {
        // continue
    }

    const objectStart = candidate.indexOf('{');
    const objectEnd = candidate.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
        const slice = candidate.slice(objectStart, objectEnd + 1);
        try {
            return JSON.parse(slice);
        } catch {
            // continue
        }
    }

    const arrayStart = candidate.indexOf('[');
    const arrayEnd = candidate.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
        const slice = candidate.slice(arrayStart, arrayEnd + 1);
        try {
            return JSON.parse(slice);
        } catch {
            // continue
        }
    }

    return null;
}

function normalizeTimetable(parsed, duration) {
    const timetable = Array.isArray(parsed) ? parsed : parsed?.timetable;
    if (!Array.isArray(timetable)) return null;

    return timetable
        .filter(Boolean)
        .slice(0, duration)
        .map((item) => ({
            time: item?.time ?? '',
            activity: item?.activity ?? '',
            description: item?.description ?? '',
            badge: item?.badge ?? null
        }));
}

async function getBody(req) {
    if (req.body !== undefined) return req.body;

    const chunks = [];
    await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
            chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
    });

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        res.status(500).json({ error: 'Missing API_KEY environment variable.' });
        return;
    }

    let body = await getBody(req);
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            body = null;
        }
    }

    const focus = typeof body?.focus === 'string' ? body.focus.trim() : '';
    const duration = Number(body?.duration);
    const constraints = typeof body?.constraints === 'string' ? body.constraints.trim() : '';

    if (!focus) {
        res.status(400).json({ error: 'Missing focus.' });
        return;
    }

    if (!Number.isFinite(duration) || duration < 1 || duration > 24) {
        res.status(400).json({ error: 'Invalid duration. Must be a number between 1 and 24.' });
        return;
    }

    const baseUrl = process.env.AI_BASE_URL || DEFAULT_BASE_URL;
    const model = process.env.AI_MODEL || DEFAULT_MODEL;

    const systemPrompt =
        'You are a scheduling API. Return ONLY valid JSON. No markdown, no code fences, no extra text.';

    const userPrompt = [
        `Create a ${duration}-hour timetable focused on: ${focus}.`,
        constraints ? `Constraints/preferences: ${constraints}` : 'Constraints/preferences: none.',
        'Use 1-hour blocks starting at 08:00.',
        'Return a JSON object with shape: { "timetable": [ ... ] }.',
        'Each timetable item must be an object with:',
        '- time: string like "08:00 - 09:00"',
        '- activity: short title',
        '- description: one sentence',
        '- badge: one of "work", "study", "break", "meal", or null',
        `Return exactly ${duration} items unless constraints make it impossible.`
    ].join('\n');

    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'X-API-Key': apiKey
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: 900
            })
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            const message =
                data?.error?.message ||
                data?.error ||
                data?.message ||
                `Upstream request failed (${response.status})`;
            res.status(502).json({ error: message });
            return;
        }

        const content = data?.choices?.[0]?.message?.content;
        const parsed = tryParseJson(content);
        const timetable = normalizeTimetable(parsed, duration);

        if (!timetable) {
            res.status(502).json({ error: 'AI response was not valid JSON in the expected format.' });
            return;
        }

        res.status(200).json({ timetable });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
};
