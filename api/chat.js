import { NextResponse } from 'next/server';

export async function POST(req) {
  console.log('=== API-anrop startat: POST /api/chat ==='); // Startlogg för att se om endpointen ens triggas

  try {
    console.log('Försöker parsa request-body...');
    const body = await req.json();
    console.log('Parsad body:', JSON.stringify(body, null, 2)); // Logga hela inkommande data

    const { message } = body;
    if (!message) {
      console.warn('Varning: Inget "message" i body');
    }
    console.log('Mottaget meddelande:', message || 'Inget meddelande skickat');

    // Kolla miljövariabler (även om vi inte använder dem nu, för att logga om de saknas)
    const groqApiKey = process.env.GROQ_API_KEY;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    console.log('GROQ_API_KEY exists:', !!groqApiKey);
    console.log('PINECONE_API_KEY exists:', !!pineconeApiKey);

    // Simulera ett enkelt svar (hårdkodat för test)
    console.log('Genererar test-svar...');
    const testReply = `Test-svar från backend: Mottaget meddelande var "${message || 'inget'}". Allt verkar fungera!`;

    console.log('=== API-anrop lyckades ===');
    return NextResponse.json({ reply: testReply });
  } catch (error) {
    // Maximal error-logging
    console.error('=== FEL I API ===');
    console.error('Error message:', error.message);
    console.error('Error name:', error.name);
    console.error('Error stack:', error.stack);
    console.error('Error cause:', error.cause ? JSON.stringify(error.cause) : 'Ingen cause');
    console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    console.error('Request method:', req.method);
    console.error('Request headers:', JSON.stringify(Object.fromEntries(req.headers), null, 2));
    console.error('=== SLUT PÅ FELLOGG ===');

    return NextResponse.json({ error: 'Internt serverfel - se Vercel-logs för detaljer' }, { status: 500 });
  }
}
