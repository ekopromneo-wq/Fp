let bindingCounter = 0;

/**
 * Patches window.RTCPeerConnection inside the page (before any navigation,
 * via addInitScript) so we get notified whenever a peer connection's state
 * changes. Works for any platform built on standard WebRTC (Telemost, Meet,
 * Zoom's web client, etc) without needing platform-specific selectors.
 * Calls onStateChange(state) for every "connectionstatechange" event.
 */
export async function installWebrtcMonitor(page, onStateChange) {
  const bindingName = `__voxmateRtcState${bindingCounter += 1}`;

  await page.exposeFunction(bindingName, (state) => {
    onStateChange(state);
  });

  await page.addInitScript((bindingNameInPage) => {
    const NativeRTCPeerConnection = window.RTCPeerConnection;

    if (!NativeRTCPeerConnection) {
      return;
    }

    window.RTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
      construct(target, args) {
        const pc = new target(...args);
        pc.addEventListener('connectionstatechange', () => {
          window[bindingNameInPage](pc.connectionState);
        });
        return pc;
      },
    });
  }, bindingName);
}
