// Avoid dumping transaction bytecode/calldata and endpoint tokens on RPC errors.
process.on('uncaughtException', (error: Error & { shortMessage?: string; details?: string; cause?: unknown }) => {
  const messages: string[] = [];
  let current: typeof error | undefined = error;
  for (let i = 0; current && i < 6; i++) {
    const text = current.shortMessage ?? current.details ?? current.message;
    if (text) messages.push(text.replace(/https?:\/\/\S+/g, '[RPC endpoint]').replace(/0x[0-9a-fA-F]{64,}/g, '[hex data]').slice(0, 400));
    current = current.cause as typeof current;
  }
  console.error([...new Set(messages)].join('\n'));
  process.exit(1);
});
