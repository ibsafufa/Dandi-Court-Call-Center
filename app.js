const socket = io();

const $ = (id) => document.getElementById(id);
const joinPanel = $("joinPanel");
const callPanel = $("callPanel");
const nameInput = $("nameInput");
const roomInput = $("roomInput");
const joinBtn = $("joinBtn");
const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");
const statusEl = $("status");
const messageEl = $("message");
const micBtn = $("micBtn");
const cameraBtn = $("cameraBtn");
const screenBtn = $("screenBtn");
const hangupBtn = $("hangupBtn");
const connectionBadge = $("connectionBadge");

let roomId = "";
let localStream = null;
let peerConnection = null;
let screenStream = null;
let isJoined = false;
let ignoreOffer = false;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
    // For reliable calls across restrictive networks, add your TURN server here:
    // { urls: "turn:YOUR_TURN_DOMAIN:3478", username: "TURN_USERNAME", credential: "TURN_PASSWORD" }
  ]
};

function showMessage(message) { messageEl.textContent = message || ""; }
function setStatus(message) { statusEl.textContent = message; }
function setBadge(message) { connectionBadge.textContent = message; }

$("generateBtn").addEventListener("click", () => {
  roomInput.value = "CALL-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  updateInviteLink();
});
roomInput.addEventListener("input", updateInviteLink);
$("copyLinkBtn").addEventListener("click", async () => {
  if (!roomInput.value.trim()) $("generateBtn").click();
  updateInviteLink();
  const link = new URL(location.href);
  link.searchParams.set("room", roomInput.value.trim());
  try {
    await navigator.clipboard.writeText(link.toString());
    showMessage("Invitation link copied. Send it to the other participant.");
  } catch {
    showMessage("Copy was blocked by the browser. Copy this page URL and add ?room=" + encodeURIComponent(roomInput.value.trim()));
  }
});
function updateInviteLink() {
  const room = roomInput.value.trim();
  if (room && new URL(location.href).searchParams.has("room")) {
    history.replaceState(null, "", "?room=" + encodeURIComponent(room));
  }
}

const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom) roomInput.value = initialRoom;

joinBtn.addEventListener("click", joinCall);
hangupBtn.addEventListener("click", leaveCall);
micBtn.addEventListener("click", toggleMic);
cameraBtn.addEventListener("click", toggleCamera);
screenBtn.addEventListener("click", toggleScreen);

async function joinCall() {
  if (isJoined) return;
  showMessage("");
  roomId = roomInput.value.trim();
  if (!roomId) return showMessage("Enter a room code or generate one.");
  joinBtn.disabled = true;

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera/microphone access requires HTTPS (or localhost). Open this site using a secure HTTPS address.");
    }
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localVideo.srcObject = localStream;

    const result = await new Promise((resolve) => {
      socket.emit("join-room", { roomId, userName: nameInput.value.trim() || "Guest" }, resolve);
    });
    if (!result?.ok) throw new Error(result?.message || "Could not join the room.");

    isJoined = true;
    joinPanel.classList.add("hidden");
    callPanel.classList.remove("hidden");
    $("roomTitle").textContent = "Room: " + roomId;
    setStatus(result.otherUserPresent ? "Other participant found. Connecting…" : "Waiting for the other participant to join…");
    micBtn.disabled = cameraBtn.disabled = screenBtn.disabled = false;
    // The existing participant creates the offer when the second person joins.
  } catch (error) {
    showMessage(error.message || "Unable to start the call.");
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    joinBtn.disabled = false;
  }
}

async function createPeerConnection(addLocalTracks = false) {
  if (peerConnection) return peerConnection;
  peerConnection = new RTCPeerConnection(rtcConfig);
  if (addLocalTracks && localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) remoteVideo.srcObject = event.streams[0];
  };
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("ice-candidate", candidate);
  };
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    if (state === "connected") {
      setStatus("Call connected.");
      setBadge("Connected");
    } else if (state === "connecting") {
      setStatus("Establishing secure peer connection…");
      setBadge("Connecting");
    } else if (state === "failed") {
      setStatus("Connection failed. A TURN server may be required on this network.");
      setBadge("Failed");
    } else if (state === "disconnected") {
      setStatus("Connection interrupted.");
      setBadge("Disconnected");
    }
  };
  return peerConnection;
}

async function startOffer() {
  try {
    const pc = await createPeerConnection(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", pc.localDescription);
  } catch (error) {
    console.error("Offer error:", error);
    showMessage("Could not start the call. Please leave and join again.");
  }
}

socket.on("peer-joined", ({ userName } = {}) => {
  if (!isJoined) return;
  $("remoteLabel").textContent = userName || "Other participant";
  setStatus("Participant joined. Starting call…");
  // The participant already in the room starts the call.
  if (!peerConnection) startOffer();
});

socket.on("waiting-for-peer", () => {
  if (isJoined) setStatus("Waiting for the other participant to join…");
});

socket.on("offer", async (offer) => {
  try {
    const pc = await createPeerConnection(false);
    await pc.setRemoteDescription(offer);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        if (!pc.getSenders().some(sender => sender.track === track)) pc.addTrack(track, localStream);
      });
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", pc.localDescription);
  } catch (error) {
    console.error("Offer handling error:", error);
    showMessage("Could not accept the call. Please leave and join again.");
  }
});

socket.on("answer", async (answer) => {
  if (!peerConnection) return;
  try { await peerConnection.setRemoteDescription(answer); }
  catch (error) { console.error("Answer error:", error); }
});

socket.on("ice-candidate", async (candidate) => {
  if (!peerConnection) return;
  try { await peerConnection.addIceCandidate(candidate); }
  catch (error) { console.error("ICE candidate error:", error); }
});

socket.on("peer-left", () => {
  setStatus("The other participant left the call.");
  setBadge("Participant left");
  remoteVideo.srcObject = null;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  // Keep local media active; the next participant will trigger a new offer.
});

function toggleMic() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "Mute mic" : "Unmute mic";
}
function toggleCamera() {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  cameraBtn.textContent = track.enabled ? "Turn camera off" : "Turn camera on";
}
async function toggleScreen() {
  if (!peerConnection) return;
  try {
    if (!screenStream) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(screenTrack);
      localVideo.srcObject = screenStream;
      screenTrack.onended = stopScreenShare;
      screenBtn.textContent = "Stop sharing";
    } else {
      await stopScreenShare();
    }
  } catch (error) {
    if (error.name !== "NotAllowedError") showMessage("Screen sharing could not start: " + error.message);
  }
}
async function stopScreenShare() {
  if (!screenStream) return;
  const cameraTrack = localStream?.getVideoTracks()[0];
  const sender = peerConnection?.getSenders().find(s => s.track?.kind === "video");
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
  screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;
  localVideo.srcObject = localStream;
  screenBtn.textContent = "Share screen";
}

function leaveCall() {
  if (screenStream) screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  if (isJoined) socket.emit("leave-room");
  isJoined = false;
  roomId = "";
  callPanel.classList.add("hidden");
  joinPanel.classList.remove("hidden");
  joinBtn.disabled = false;
  micBtn.disabled = cameraBtn.disabled = screenBtn.disabled = true;
  micBtn.textContent = "Mute mic";
  cameraBtn.textContent = "Turn camera off";
  screenBtn.textContent = "Share screen";
  setBadge("Not connected");
  setStatus("Call ended.");
  showMessage("");
}
window.addEventListener("beforeunload", () => {
  if (isJoined) socket.emit("leave-room");
});
