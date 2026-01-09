const { Groq } = require('groq-sdk');
const csv = require('csv-parser');
const { Pinecone } = require('@pinecone-database/pinecone');
const { HuggingFaceInferenceEmbeddings } = require('@langchain/community/embeddings/hf');
const { PineconeStore } = require('@langchain/community/vectorstores/pinecone');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';
let cachedData = [];
let lastCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuter
// Pinecone & Embeddings setup
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME || 'fortus-support');
const embeddings = new HuggingFaceInferenceEmbeddings({
  model: 'sentence-transformers/all-MiniLM-L6-v2', // 384 dims, gratis HF
});
async function loadCSVAndUpdateVectorStore() {
  if (Date.now() - lastCacheTime < CACHE_DURATION && cachedData.length > 0) {
    return cachedData;
  }
  try {
    const response = await fetch(CSV_URL);
    if (!response.ok) throw new Error('CSV fetch failed');
    const text = await response.text();
    const results = [];
    await new Promise((resolve, reject) => {
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
    // Uppdatera Pinecone med embeddings
    const texts = cachedData.map(row => Object.values(row).join(' ')); // Rad som text
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });
    const chunks = await splitter.splitTexts(texts);
    const metadatas = cachedData.map((row, i) => ({ id: i.toString(), ...row })); // Metadata med rad-ID
    await PineconeStore.fromTexts(chunks, metadatas, embeddings, { pineconeIndex });
    return results;
  } catch (error) {
    console.error('CSV/Pinecone update error:', error);
    throw error;
  }
}
async function advancedRAG(query, data) {
  try {
    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex });
    const results = await vectorStore.similaritySearch(query, 5); // Top-5
    return results.map(res => res.pageContent).join('\n');
  } catch (error) {
    console.error('Advanced RAG error, fallback to simple:', error);
    return simpleRAG(query, data);
  }
}
// Simple fallback
function simpleRAG(query, data) {
  const queryLower = query.toLowerCase();
  const relevant = data.filter(row =>
    Object.values(row).some(val => val.toLowerCase().includes(queryLower))
  );
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
    const data = await loadCSVAndUpdateVectorStore();
    const context = await advancedRAG(message, data);
    const completion = await gro
