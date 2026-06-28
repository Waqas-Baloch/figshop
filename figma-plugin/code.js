// Figshop — Figma plugin main thread (sandbox).
//
// This half can touch the Figma document but CANNOT do network I/O.
// All networking lives in ui.html, which talks to the local bridge.
// We just shuttle messages between the document and the UI iframe.

figma.showUI(__html__, { width: 340, height: 380, title: 'Figshop' });

const EXPORT_SCALE = 2; // export images at 2x so Photoshop edits stay crisp

// Route the command the plugin was launched with.
// '' (quick actions) and 'connect' just open the panel.
const command = figma.command || 'connect';

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case 'ui-ready':
      if (command === 'edit') await editSelection(false);
      else if (command === 'reset') await editSelection(true);
      break;
    case 'edit':
      await editSelection(false);
      break;
    case 'reset':
      await editSelection(true);
      break;
    case 'apply':
      await applyUpdate(msg.nodeId, msg.png);
      break;
    case 'open-url':
      // Used by the UI to open the installer download or wake the helper
      // (figshop://). openExternal may reject non-http schemes — that's fine.
      try { figma.openExternal(msg.url); } catch (e) { /* best effort */ }
      break;
  }
};

// --- send selected image(s) to Photoshop -----------------------------------

async function editSelection(force) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify('Select an image layer first.');
    return;
  }
  for (const node of selection) {
    try {
      await sendNode(node, force);
    } catch (e) {
      figma.notify(`Couldn't open "${node.name}": ${e.message}`);
    }
  }
}

async function sendNode(node, force) {
  if (!('fills' in node)) {
    throw new Error('this layer type has no image fill');
  }
  // Export at up to 2×, but keep both dimensions within Figma's 4096px image
  // limit so the edited result can be applied back on the way in.
  const maxDim = Math.max(node.width || 1, node.height || 1);
  const scale = Math.min(EXPORT_SCALE, 4096 / maxDim);
  const bytes = await node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: scale },
  });

  // Persist a right-click / panel "Edit in Photoshop" button on this node.
  node.setRelaunchData({ edit: 'Open this image in Photoshop' });

  figma.ui.postMessage({
    type: 'open',
    nodeId: node.id,
    name: node.name,
    png: figma.base64Encode(bytes),
    force: !!force,
  });
  figma.notify(`Opening "${node.name}" in Photoshop…`);
}

// --- apply an edit coming back from Photoshop ------------------------------

async function applyUpdate(nodeId, base64Png) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !('fills' in node)) {
    figma.notify('Original layer not found — it may have been deleted.');
    return;
  }

  const fills = node.fills;
  if (fills === figma.mixed) {
    figma.notify('Layer has mixed fills — open it individually.');
    return;
  }
  let image;
  try {
    image = figma.createImage(figma.base64Decode(base64Png));
  } catch (e) {
    figma.notify('Image too large for Figma (max 4096×4096). Scale it down in Photoshop.');
    return;
  }

  // Replace the existing image paint in place (keeps scaleMode, opacity, etc.).
  const next = clone(fills);
  const target = next.find((p) => p.type === 'IMAGE');
  if (target) {
    target.imageHash = image.hash;
  } else {
    next.push({ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash });
  }
  node.fills = next;
  figma.notify(`Updated "${node.name}" from Photoshop ✓`);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
