// One Diagnostics row for the chat socket, however many chat switches are on.

const shown = new WeakSet();

export function chatSocketRow({ net, diagnostics }) {
  if (!net || !diagnostics || shown.has(net)) return;
  shown.add(net);
  diagnostics.add('Chat socket', () => {
    const { messages, unreadable } = net.chatStats;
    if (!messages) return "Facebook hasn't sent anything over chat in this tab yet";
    const sent = `${messages} ${messages === 1 ? 'message' : 'messages'} sent`;
    return unreadable ? `${sent}, ${unreadable} the script couldn't read` : sent;
  });
}
