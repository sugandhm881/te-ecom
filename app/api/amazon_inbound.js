// FBA inbound (Fulfillment Inbound 2024-03-20) — India-adapted flow.
// India specifics discovered empirically: packing OPTIONS are unsupported (skip); placement REQUIRES
// customPlacement (seller picks the destination FC, e.g. DEL4/DEL5); items need prepOwner + labelOwner.
// Every generate*/confirm* is async → returns an operationId we poll via getInboundOperationStatus.
const { makeSignedApiRequest } = require('./helpers');

const B = '/inbound/fba/2024-03-20';
const MKT = (require('../../config').MARKETPLACE_ID) || 'A21TJRUUN4KGV';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Default ship-from (their Gurgaon warehouse, from their existing plans). Overridable per call.
const DEFAULT_SOURCE = {
    name: 'Ravinder Kumar', companyName: 'Shifupro Technologies Pvt. Ltd.',
    addressLine1: 'Shop 19,', addressLine2: 'AIPL Boulevard, Sector 70A',
    city: 'Gurgaon', stateOrProvinceCode: 'Haryana', postalCode: '122001', countryCode: 'IN',
    phoneNumber: '8826382299', email: 'theelementgurgaon@gmail.com'
};

async function inbReq(path, method = 'GET', bodyObj, queryParams) {
    const o = { method, path };
    if (queryParams) o.queryParams = queryParams;
    if (bodyObj !== undefined) { o.body = JSON.stringify(bodyObj); o.headers = { 'Content-Type': 'application/json' }; }
    try {
        return await makeSignedApiRequest(o);
    } catch (e) {
        // Surface Amazon's real error text instead of axios' generic "status code 400".
        const d = e.response && e.response.data;
        const msg = (d && d.errors && d.errors.map(x => x.message).filter(Boolean).join('; ')) || e.message;
        const err = new Error(msg); err.status = e.response && e.response.status; err.amazon = d;
        throw err;
    }
}

// Poll an async operation to a terminal state. Throws with the problem detail on FAILED.
async function awaitOperation(operationId, { intervalMs = 4000, maxWaitMs = 180000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const r = await inbReq(`${B}/operations/${operationId}`);
        if (r.operationStatus === 'SUCCESS') return r;
        if (r.operationStatus === 'FAILED') {
            const msg = (r.operationProblems || []).map(p => p.message).join('; ') || 'operation failed';
            const err = new Error(msg); err.operationProblems = r.operationProblems; throw err;
        }
    }
    throw new Error(`Inbound operation ${operationId} timed out`);
}

// ── Stage wrappers ──────────────────────────────────────────────────────────
async function createInboundPlan({ items, sourceAddress, name }) {
    const r = await inbReq(`${B}/inboundPlans`, 'POST', {
        destinationMarketplaces: [MKT],
        name: name || ('Restock ' + new Date().toISOString().slice(0, 10)),
        sourceAddress: sourceAddress || DEFAULT_SOURCE,
        items: items.map(i => ({ msku: i.msku, quantity: i.quantity, prepOwner: i.prepOwner || 'NONE', labelOwner: i.labelOwner || 'SELLER' }))
    });
    await awaitOperation(r.operationId);
    return r.inboundPlanId;
}

const getInboundPlan = planId => inbReq(`${B}/inboundPlans/${planId}`);

// India: one custom-placement group per destination FC.
async function generatePlacement(planId, groups) {
    const customPlacement = groups.map(g => ({
        warehouseId: g.warehouseId,
        items: g.items.map(i => ({ msku: i.msku, quantity: i.quantity, prepOwner: i.prepOwner || 'NONE', labelOwner: i.labelOwner || 'SELLER' }))
    }));
    const r = await inbReq(`${B}/inboundPlans/${planId}/placementOptions`, 'POST', { customPlacement });
    await awaitOperation(r.operationId);
    const list = await inbReq(`${B}/inboundPlans/${planId}/placementOptions`);
    return list.placementOptions || [];
}

async function confirmPlacement(planId, placementOptionId) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/placementOptions/${placementOptionId}/confirmation`, 'POST', {});
    await awaitOperation(r.operationId);
    return true;
}

const getShipment = (planId, shipmentId) => inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}`);
const listPlanBoxes = (planId, shipmentId) => inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}/boxes`);
const listPlanItems = (planId, shipmentId) => inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}/items`);

// Box/packing details (weights + dims + contents) — needed before labels.
async function setPackingInformation(planId, packageGroupings) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/packingInformation`, 'POST', { packageGroupings });
    await awaitOperation(r.operationId);
    return true;
}

async function generateTransportation(planId, body) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/transportationOptions`, 'POST', body);
    await awaitOperation(r.operationId);
    const q = new URLSearchParams({ pageSize: '20', placementOptionId: body.placementOptionId }).toString();
    const list = await inbReq(`${B}/inboundPlans/${planId}/transportationOptions?${q}`);
    return list.transportationOptions || [];
}

async function confirmTransportation(planId, transportationSelections) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/transportationOptions/confirmation`, 'POST', { transportationSelections });
    await awaitOperation(r.operationId);
    return true;
}

const listDeliveryWindowOptions = (planId, shipmentId) => inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}/deliveryWindowOptions`);
async function generateDeliveryWindowOptions(planId, shipmentId) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}/deliveryWindowOptions`, 'POST', {});
    await awaitOperation(r.operationId);
    return listDeliveryWindowOptions(planId, shipmentId);
}
async function confirmDeliveryWindowOption(planId, shipmentId, deliveryWindowOptionId) {
    const r = await inbReq(`${B}/inboundPlans/${planId}/shipments/${shipmentId}/deliveryWindowOptions/${deliveryWindowOptionId}/confirmation`, 'POST', {});
    await awaitOperation(r.operationId);
    return true;
}

// Labels via the v0 labels op (keyed by shipmentConfirmationId, e.g. FBA15M0XZRTC). India = own-carrier
// (non-partnered) small parcel → BARCODE_2D + PageStartIndex/PageSize (NOT NumberOfPackages/UNIQUE, which
// need carton IDs that ListShipmentBoxes can't return in IN). Returns { DownloadURL }.
async function getLabels(shipmentConfirmationId, { pageType = 'PackageLabel_Plain_Paper', numBoxes = 1 } = {}) {
    const r = await inbReq(`/fba/inbound/v0/shipments/${shipmentConfirmationId}/labels`, 'GET', undefined,
        { PageType: pageType, LabelType: 'BARCODE_2D', PageStartIndex: 0, PageSize: numBoxes });
    return r.payload || r;
}

const cancelInboundPlan = planId => inbReq(`${B}/inboundPlans/${planId}/cancellation`, 'PUT', {});

module.exports = {
    DEFAULT_SOURCE, inbReq, awaitOperation,
    createInboundPlan, getInboundPlan, generatePlacement, confirmPlacement,
    getShipment, listPlanBoxes, listPlanItems, setPackingInformation,
    generateTransportation, confirmTransportation,
    generateDeliveryWindowOptions, listDeliveryWindowOptions, confirmDeliveryWindowOption,
    getLabels, cancelInboundPlan
};
