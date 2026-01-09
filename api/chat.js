module.exports = (req, res) => {
  console.log('Steg 3: Backend funktion invoked – method:', req.method, 'body:', req.body); // Log vid entry
  res.status(200).json({ reply: 'Test-svar från backend: Kommunikation fungerar!' });
};
