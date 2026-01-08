const { Groq } = require('groq-sdk');
const csv = require('csv-parser');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';
let cachedData = [];
let lastCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuter

async function loadCSV() {
  if (Date.now() - lastCacheTime < CACHE_DURATION && cachedData.length > 0) {
    return cachedData;
  }
  const response = await fetch(CSV_URL);
  const text = await response.text();
  const results = [];
  return new Promise((resolve, reject) => {
    const stream = require('stream');
    const readable = new stream.Readable();
    readable.push(text);
    readable.push(null);
    readable
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        cachedData = results;
        lastCacheTime = Date.now();
        resolve(results);
      })
      .on('error', reject);
  });
}

// Synonym-mapping för vanliga termer (lägg till fler vid behov)
const synonyms = {
  'z-rapport': ['dagsavslut', 'z-rapport'],
  'fakturor': ['faktura', 'anslut faktura'],
  'swish': ['swish', 'anslut swish'],
  'stand': ['montera stand', 'stand'],
  // Lägg till fler, t.ex. 'mpos': ['mpos', 'mobil pos']
};

// Förbättrad RAG med synonymer, lowercase, ordöverlapp >=0.4
function simpleRAG(query, data) {
  let queryWords = query.toLowerCase().split(' ').filter(word => word.length > 2);
  // Lägg till synonymer till queryWords
  queryWords.forEach(word => {
    if (synonyms[word]) {
      queryWords = [...new Set([...queryWords, ...synonyms[word].map(w => w.toLowerCase())])];
    }
  });

  const relevant = data.filter(row => {
    const rowText = Object.values(row).join(' ').toLowerCase();
    const rowWords = rowText.split(' ').filter(word => word.length > 2);
    const overlap = queryWords.filter(word => rowWords.includes(word)).length;
    return overlap / queryWords.length >= 0.4; // Sänkt tröskel för bättre känslighet
  });
  // Sortera efter relevans
  relevant.sort((a, b) => {
    const overlapA = queryWords.filter(word => Object.values(a).join(' ').toLowerCase().includes(word)).length;
    const overlapB = queryWords.filter(word => Object.values(b).join(' ').toLowerCase().includes(word)).length;
    return overlapB - overlapA;
  });
  return relevant.map(row => JSON.stringify(row)).join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    const data = await loadCSV();
    const context = simpleRAG(message, data);

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Du är en hjälpsam support-AI för FortusPay. Använd ENDAST information från kunskapsbasen för att svara – hallucinera INTE egna svar eller allmän kunskap. Om inget matchar i kunskapsbasen, säg 'Jag hittade ingen specifik info i vår kunskapsbas. Kontakta support@fortuspay.com eller ring 010-222 15 20 för hjälp.' Strukturera svar: **Fråga:** [sammanfattning av användarens fråga] **Svar:** [exakta detaljer från kunskapsbasen, inkludera ID:n, steg, länkar etc.] **Källa:** [referens från kunskapsbasen, t.ex. 'Anslut Swish']. Kunskapsbas: ${context || 'Ingen matchande data.'}`,
        },
        { role: 'user', content: message },
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 500,
    });

    const reply = completion.choices[0]?.message?.content || 'Inget svar genererat.';
    res.status(200).json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Serverfel' });
  }
};
