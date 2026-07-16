// Figshop — Figma plugin main thread (sandbox).
//
// This half can touch the Figma document but CANNOT do network I/O.
// All networking lives in ui.html, which talks to the local bridge.
// We just shuttle messages between the document and the UI iframe.

figma.showUI(__html__, { width: 340, height: 380, title: 'Figma To Photoshop' });

const EXPORT_SCALE = 2; // export images at 2x so Photoshop edits stay crisp

// Route the command the plugin was launched with.
// '' (quick actions) and 'connect' just open the panel.
const command = figma.command || 'connect';

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case 'ui-ready': {
      // Hand the UI the saved pairing token so it can authenticate to the
      // companion app. Stored per-user by Figma, entered once.
      const saved = await figma.clientStorage.getAsync('pairingToken');
      figma.ui.postMessage({ type: 'config', token: saved || '' });
      if (command === 'edit') await editSelection(false);
      else if (command === 'reset') await resetSelection();
      break;
    }
    case 'save-token': {
      const t = String(msg.token || '').trim();
      await figma.clientStorage.setAsync('pairingToken', t);
      figma.ui.postMessage({ type: 'config', token: t });
      figma.notify('Pairing code saved.');
      break;
    }
    case 'edit':
      await editSelection(false);
      break;
    case 'reset':
      await resetSelection();
      break;
    case 'apply':
      await applyUpdate(msg.nodeId, msg.png);
      break;
    case 'place':
      await placePsd(msg);
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

// A group/frame of vectors can't show an image fill (its children paint over it),
// so those get an image "proxy" instead — see applyUpdate.
const isContainer = (node) => 'children' in node && node.children.length > 0;
const proxyOf = async (node) => {
  const id = node.getPluginData('proxyId');
  if (!id) return null;
  const p = await figma.getNodeByIdAsync(id);
  return p && !p.removed ? p : null;
};

async function sendNode(node, force) {
  if (!('exportAsync' in node)) {
    throw new Error('this layer type cannot be exported');
  }
  // Editing a proxy image reopens the ORIGINAL artwork's PSD, so the bridge is
  // always keyed by the source node.
  const key = node.getPluginData('sourceId') || node.id;

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
    nodeId: key,
    name: node.name,
    png: figma.base64Encode(bytes),
    force: !!force,
  });
  figma.notify(`Opening "${node.name}" in Photoshop…`);
}

// --- apply an edit coming back from Photoshop ------------------------------

async function applyUpdate(nodeId, base64Png) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.removed) {
    figma.notify('Original layer not found — it may have been deleted.');
    return;
  }

  let image;
  try {
    image = figma.createImage(figma.base64Decode(base64Png));
  } catch (e) {
    figma.notify('Image too large for Figma (max 4096×4096). Scale it down in Photoshop.');
    return;
  }

  // The PNG is the node's fully-rendered appearance at the node's own aspect
  // ratio, so it must map 1:1 onto the node. Carrying over the previous paint's
  // geometry (a CROP imageTransform, TILE scalingFactor, FIT, or rotation) would
  // re-transform an already-transformed image — that's what stretched it. Keep
  // only the cosmetic properties.
  const cleanPaint = (old) => {
    const p = { type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash };
    if (old) {
      if (old.opacity !== undefined) p.opacity = old.opacity;
      if (old.visible !== undefined) p.visible = old.visible;
      if (old.blendMode !== undefined) p.blendMode = old.blendMode;
    }
    return p;
  };

  // 1) Already has a proxy image from a previous edit → just refresh it.
  const existing = await proxyOf(node);
  if (existing) {
    existing.fills = [cleanPaint(null)];
    figma.notify(`Updated "${node.name}" from Photoshop ✓`);
    return;
  }

  // 2) Vector artwork (group/frame): its children would paint over any fill, so
  //    keep the original artwork intact but hidden and show the edit in its slot.
  if (isContainer(node)) {
    const rect = figma.createRectangle();
    rect.resize(Math.max(1, node.width), Math.max(1, node.height));
    rect.x = node.x;
    rect.y = node.y;
    rect.name = `${node.name} (Photoshop)`;
    rect.fills = [cleanPaint(null)];

    const parent = node.parent;
    parent.insertChild(parent.children.indexOf(node), rect); // same z-slot
    node.visible = false;                                    // vectors preserved, just hidden

    node.setPluginData('proxyId', rect.id);
    rect.setPluginData('sourceId', node.id);
    rect.setRelaunchData({ edit: 'Open this image in Photoshop' });
    figma.currentPage.selection = [rect];
    figma.notify(`Updated "${node.name}" ✓ — original vectors kept (hidden). Reset restores them.`);
    return;
  }

  // 3) A leaf (image, vector, shape): paint it in place — a vector keeps its
  //    path/strokes and clips the image to its own shape.
  if ('fills' in node) {
    const fills = node.fills;
    if (fills === figma.mixed) {
      figma.notify('Layer has mixed fills — open it individually.');
      return;
    }
    const next = clone(fills);
    const i = next.findIndex((p) => p.type === 'IMAGE');
    if (i >= 0) next[i] = cleanPaint(next[i]); // replace in place (keeps z-order)
    else next.push(cleanPaint(null));          // vector: paints inside its shape
    node.fills = next;
    figma.notify(`Updated "${node.name}" from Photoshop ✓`);
    return;
  }

  figma.notify(`Can't apply the edit to "${node.name}" (unsupported layer type).`);
}

// Reset: on a proxy image, bring the original vector artwork back.
async function resetSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify('Select a layer first.');
    return;
  }
  for (const node of selection) {
    const sourceId = node.getPluginData('sourceId');
    if (sourceId) {
      const source = await figma.getNodeByIdAsync(sourceId);
      if (source && !source.removed) {
        source.visible = true;
        source.setPluginData('proxyId', '');
        figma.currentPage.selection = [source];
        node.remove();
        figma.notify(`Restored the original artwork for "${source.name}".`);
        continue;
      }
    }
    // Not a proxy → force a fresh re-import from Figma.
    try {
      await sendNode(node, true);
    } catch (e) {
      figma.notify(`Couldn't reset "${node.name}": ${e.message}`);
    }
  }
}

// --- place a layered PSD as a new image, linked to its layers --------------

async function placePsd(msg) {
  let image;
  try {
    image = figma.createImage(figma.base64Decode(msg.png));
  } catch (e) {
    figma.notify('Could not place PSD: ' + e.message);
    return;
  }
  const rect = figma.createRectangle();
  rect.resize(Math.max(1, msg.width), Math.max(1, msg.height));
  rect.name = (msg.name || 'PSD').replace(/\.(psd|psb)$/i, '');
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

  // Drop it at the center of the current viewport.
  const center = figma.viewport.center;
  rect.x = Math.round(center.x - msg.width / 2);
  rect.y = Math.round(center.y - msg.height / 2);
  figma.currentPage.appendChild(rect);

  rect.setRelaunchData({ edit: 'Open this image in Photoshop' });
  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);

  // Tell the bridge which node now owns this PSD's layers.
  figma.ui.postMessage({ type: 'bind', importId: msg.importId, nodeId: rect.id, name: rect.name });
  figma.notify(`Placed "${rect.name}" — Edit in Photoshop opens its layers.`);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
