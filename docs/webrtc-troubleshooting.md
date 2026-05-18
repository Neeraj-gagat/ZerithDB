# WebRTC Troubleshooting Guide

This guide covers common WebRTC issues, their possible causes, and recommended solutions.

---

## 1. ICE Connection Failure

### Symptoms
- Peer connection remains in "connecting" state
- Remote stream never appears
- Connection eventually times out

### Possible Causes
- Incorrect STUN/TURN server configuration
- Firewall or NAT restrictions
- TURN server unavailable

### Solutions
- Verify STUN/TURN server credentials
- Ensure TURN fallback is enabled
- Test network connectivity
- Check browser console logs for ICE errors

---

## 2. No Audio During Calls

### Symptoms
- Connected successfully but no sound
- One participant cannot hear the other

### Possible Causes
- Microphone permission denied
- Incorrect media device selected
- Muted audio tracks

### Solutions
- Allow microphone permissions in browser
- Verify correct input/output devices
- Ensure audio tracks are enabled

---

## 3. No Video Stream

### Symptoms
- Black screen during video call
- Camera feed not loading

### Possible Causes
- Camera access blocked
- Unsupported browser
- Media stream initialization failure

### Solutions
- Grant camera permissions
- Restart browser and camera device
- Test in Chromium-based browsers or Firefox

---

## 4. High Latency or Lag

### Symptoms
- Delayed audio/video
- Choppy communication

### Possible Causes
- Slow internet connection
- High bitrate settings
- Network congestion

### Solutions
- Reduce video resolution
- Lower bitrate settings
- Use stable internet connection

---

## 5. Peer Connection Closed Unexpectedly

### Symptoms
- Call disconnects randomly
- Reconnection attempts fail

### Possible Causes
- Signaling server interruption
- ICE timeout
- Network switching

### Solutions
- Reconnect signaling server
- Restart peer connection
- Monitor ICE connection state changes

---

## Debugging Tips

- Use browser developer tools
- Monitor ICE candidate exchange
- Check signaling server logs
- Test with multiple browsers and networks

---

## Recommended Browsers

- Google Chrome
- Mozilla Firefox
- Microsoft Edge