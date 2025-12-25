// --- STATE ---
let allOrders = [];
let performanceData = [];
let adsetPerformanceData = [];
let selectedOrderId = null;
let currentView = 'orders-dashboard';
let activePlatformFilter = 'All';
let activeSourceFilter = 'All';
let insightsPlatformFilter = 'All';
let activeStatusFilter = 'All';
let activeDatePreset = 'today';
let insightsDatePreset = 'last_7_days';
let adPerformanceDatePreset = 'last_7_days';
let adsetDatePreset = 'last_7_days';
let profitDatePreset = 'last_7_days';
let returnsDatePreset = 'last_month';
let authToken = null;
let currentSortKey = null;
let currentSortOrder = "asc";
let adRankingChartInstance = null;
let profitChartInstance = null;
let customerSegmentChartInstance = null;
let rtoProductChartInstance = null;

// --- NEW STATE FOR BULK ACTIONS ---
let selectedOrders = new Set(); 

// --- DOM ELEMENTS ---
let loginView, appView, logoutBtn, notificationEl, notificationMessageEl;
let loginBtn, loginEmailEl, loginPasswordEl;
let navOrdersDashboard, navOrderInsights, navAdRanking, navAdsetBreakdown, navAdAnalysis, navSettings, navProfitability, navCustomerSegments, navReturnsAnalysis;
let ordersDashboardView, orderInsightsView, adRankingView, adsetBreakdownView, adAnalysisView, settingsView, profitabilityView, customerSegmentsView, returnsAnalysisView;
let ordersListEl, statusFilterEl, orderDatePresetFilter, customDateContainer, startDateFilterEl, endDateFilterEl, platformFiltersEl,
    dashboardKpiElements, insightsKpiElements, revenueChartCanvas, platformChartCanvas, paymentChartCanvas,
    insightsDatePresetFilter, insightsCustomDateContainer, insightsStartDateFilterEl, insightsEndDateFilterEl,
    insightsPlatformFiltersEl,
    globalLoader; 
let adsetPerformanceTableBody, downloadPdfBtn, downloadExcelBtn, adsetDateFilterTypeEl;
let rankingDatePresetFilter, adRankingChartCanvas, adRankingListEl;
let adsetDatePresetFilter, adsetCustomDateContainer, adsetStartDateFilterEl, adsetEndDateFilterEl; 
let profitDatePresetFilter, profitCustomDateContainer, profitStartDateFilterEl, profitEndDateFilterEl, profitTrendChartCanvas; 
let returnsDatePresetFilter, returnsCustomDateContainer, returnsStartDateFilterEl, returnsEndDateFilterEl; 
let customerSegmentChartCanvas, vipCustomerListEl, rtoProductChartCanvas, rtoCityListEl, customerLimitFilter; 
let adAnalysisTableBody, adAnalysisPaymentFilter;

// New Filter Elements
let sourceFilterEl;

let revenueChartInstance, platformChartInstance, paymentChartInstance;

// --- STATIC DATA ---
let connections = [
    { name: 'Amazon', status: 'Connected', user: 'seller-amz-123' },
    { name: 'Shopify', status: 'Connected', user: 'my-store.myshopify.com' },
    { name: 'Flipkart', status: 'Not Connected', user: null },
];
const platformLogos = {
    Amazon: 'https://www.vectorlogo.zone/logos/amazon/amazon-icon.svg',
    Flipkart: 'https://brandeps.com/logo-download/F/Flipkart-logo-vector-01.svg',
    Shopify: 'https://www.vectorlogo.zone/logos/shopify/shopify-icon.svg',
};

// --- HELPER FUNCTIONS ---
function showNotification(message, isError = false) {
    if (notificationMessageEl) {
        notificationMessageEl.textContent = message;
        notificationEl.className = `fixed top-6 right-6 z-50 transform transition-all duration-300 ${isError ? 'bg-rose-600' : 'bg-slate-800'} text-white py-3 px-6 rounded-lg shadow-xl flex items-center gap-3 border border-white/10 cursor-pointer`;
        notificationEl.classList.remove('hidden', 'translate-y-[-150%]', 'opacity-0');
        setTimeout(() => {
            notificationEl.classList.add('translate-y-[-150%]', 'opacity-0');
            setTimeout(() => { notificationEl.classList.add('hidden'); }, 300);
        }, 3000);
    }
}

function showLoader() { if(globalLoader) globalLoader.classList.add('active'); }
function hideLoader() { if(globalLoader) globalLoader.classList.remove('active'); }

const formatCurrency = (amount) => {
  const value = Math.round(parseFloat(amount) || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(value);
};
const formatNumber = (num) => new Intl.NumberFormat('en-IN').format(num);
const formatPercent = (num) => isFinite(num) ? `${(num * 100).toFixed(1)}%` : '0.0%';

function getStatusBadge(status) {
    switch (status) {
        case 'New': return 'bg-blue-50 text-blue-700 border border-blue-200';
        case 'Processing': return 'bg-amber-50 text-amber-700 border border-amber-200';
        case 'Shipped': return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
        case 'Delivered': return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
        case 'Cancelled': return 'bg-slate-100 text-slate-600 border border-slate-200';
        case 'RTO': return 'bg-rose-50 text-rose-700 border border-rose-200';
        default: return 'bg-slate-50 text-slate-700 border border-slate-200';
    }
}
function createFallbackImage(itemName) {
    const initials = (itemName || 'N/A').split(' ').map(word => word[0]).join('').substring(0, 2).toUpperCase();
    return `https://placehold.co/100x100/f1f5f9/94a3b8?text=${initials}`;
}

// --- NEW HELPER: CUSTOMER BADGE ---
function getCustomerBadge(email, phone, currentOrderId) {
    if (!email && !phone) return '';
    const customerOrders = allOrders.filter(o => {
        const matchEmail = email && o.email && o.email.toLowerCase() === email.toLowerCase();
        const matchPhone = phone && (o.phone || '').includes(phone);
        return matchEmail || matchPhone;
    });
    const count = customerOrders.length;
    if (count === 1) {
        return `<span class="ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-100 rounded border border-emerald-200">New</span>`;
    } else if (count > 5) {
        return `<span class="ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 bg-amber-100 rounded border border-amber-200">VIP (${count})</span>`;
    } else {
        return `<span class="ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600 bg-indigo-100 rounded border border-indigo-200">Repeat (${count})</span>`;
    }
}

// --- AUTHENTICATION ---
async function prefillLoginDetails() { 
    try {
        const response = await fetch('/api/get-login-details');
        if (response.ok) {
            const data = await response.json();
            if (loginEmailEl && data.email) loginEmailEl.value = data.email;
            if (loginPasswordEl && data.password) loginPasswordEl.value = data.password;
        }
    } catch (error) {}
}

async function handleLogin() {
    showLoader();
    try {
        const response = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: loginEmailEl.value, password: loginPasswordEl.value })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Login failed');
        authToken = data.token;
        localStorage.setItem('authToken', authToken);
        showApp();
    } catch (error) {
        showNotification(error.message, true);
    } finally {
        hideLoader();
    }
}

function logout() {
    authToken = null; localStorage.removeItem('authToken');
    if(loginEmailEl) loginEmailEl.value = '';
    if(loginPasswordEl) loginPasswordEl.value = '';
    showLogin();
}

function showLogin() {
    if (loginView) loginView.style.display = 'flex';
    if (appView) appView.style.display = 'none';
}

function showApp() {
    if (loginView) loginView.style.display = 'none';
    if (appView) appView.style.display = 'flex';
    loadInitialData();
}

// --- API ---
function getAuthHeaders() { return authToken ? { "Authorization": `Bearer ${authToken}` } : {}; }

async function fetchApiData(endpoint, errorMessage, options = {}) {
    const headers = { ...getAuthHeaders(), ...options.headers };
    if (!headers.Authorization) { logout(); return Promise.reject("Unauthorized"); }

    try {
        const response = await fetch(`/api${endpoint}`, { ...options, headers });
        if (response.status === 401) { showNotification("Session expired.", true); logout(); return Promise.reject("Unauthorized"); }
        if (!response.ok) { const e = await response.json(); throw new Error(e.error || `Server error: ${response.status}`); }
        const cType = response.headers.get('Content-Type');
        if (cType && (cType.includes('pdf') || cType.includes('sheet'))) return await response.blob();
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) {
        showNotification(error.message || errorMessage, true);
        return Promise.reject(error.message);
    }
}

const fetchOrdersFromServer = () => fetchApiData(`/get-orders`, 'Failed to fetch orders.');
const fetchAdPerformanceData = (since, until) => fetchApiData(`/get-ad-performance?since=${since}&until=${until}`, 'Failed to fetch ad performance.');
const fetchAdsetPerformanceData = (endpoint) => fetchApiData(endpoint, 'Failed to fetch ad set performance.');

// --- ACTIONS (Client-side Download) ---
async function downloadShipmentLabel(awb) {
    if (!awb) { showNotification("No AWB number found.", true); return; }
    const btn = document.activeElement;
    const originalText = btn ? btn.textContent : 'Label';
    if(btn) btn.textContent = "Opening...";
    try {
        const response = await fetch(`/api/get-shipping-label?awb=${awb}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await response.json();
        if (response.ok && data.success && data.url) {
            window.open(data.url, '_blank');
            showNotification("Label opened in new tab.");
        } else { throw new Error(data.error || "Label URL not found"); }
    } catch (err) { showNotification("Failed: " + err.message, true); } finally { if(btn) btn.textContent = originalText; }
}

// --- UI RENDERING ---
function navigate(view) {
    console.log("Navigating to:", view);
    currentView = view;
    
    const allLinks = document.querySelectorAll('.sidebar-link');
    allLinks.forEach(link => link.classList.remove('active'));
    
    const mainContainer = document.querySelector('main');
    if (mainContainer) {
        Array.from(mainContainer.children).forEach(child => {
            if (child.tagName === 'DIV') {
                child.style.display = 'none';       
                child.classList.add('view-hidden'); 
                child.classList.add('hidden');      
            }
        });
    }

    let activeLinkElement = null;
    let activeViewElement = null;
    
    switch(view) {
        case 'orders-dashboard': 
            activeLinkElement = document.getElementById('nav-orders-dashboard'); 
            activeViewElement = document.getElementById('orders-dashboard-view'); 
            if(typeof renderAllDashboard === 'function') renderAllDashboard(); 
            break;
        case 'order-insights': 
            activeLinkElement = document.getElementById('nav-order-insights'); 
            activeViewElement = document.getElementById('order-insights-view'); 
            if(typeof renderAllInsights === 'function') renderAllInsights(); 
            break;
        case 'profitability': 
            activeLinkElement = document.getElementById('nav-profitability'); 
            activeViewElement = document.getElementById('profitability-view'); 
            if(typeof handleProfitabilityChange === 'function') handleProfitabilityChange(); 
            break;
        case 'customer-segments': 
            activeLinkElement = document.getElementById('nav-customer-segments'); 
            activeViewElement = document.getElementById('customer-segments-view'); 
            if(typeof renderCustomerSegments === 'function') renderCustomerSegments(); 
            break;
        case 'returns-analysis': 
            activeLinkElement = document.getElementById('nav-returns-analysis'); 
            activeViewElement = document.getElementById('returns-analysis-view'); 
            if(typeof renderReturnsAnalysis === 'function') renderReturnsAnalysis(); 
            break;
        case 'ad-ranking': 
            activeLinkElement = document.getElementById('nav-ad-ranking'); 
            activeViewElement = document.getElementById('ad-ranking-view'); 
            if(typeof handleAdsetDateChange === 'function') handleAdsetDateChange(true); 
            break;
        case 'adset-breakdown': 
            activeLinkElement = document.getElementById('nav-adset-breakdown'); 
            activeViewElement = document.getElementById('adset-breakdown-view'); 
            if(typeof handleAdsetDateChange === 'function') handleAdsetDateChange(false); 
            break;
        case 'ad-analysis': 
            activeLinkElement = document.getElementById('nav-ad-analysis'); 
            activeViewElement = document.getElementById('ad-analysis-view'); 
            if(typeof renderAdAnalysis === 'function') renderAdAnalysis(); 
            break;
        case 'settings': 
            activeLinkElement = document.getElementById('nav-settings'); 
            activeViewElement = document.getElementById('settings-view'); 
            if(typeof renderSettings === 'function') renderSettings(); 
            break;
        case 'reports-view': 
            activeLinkElement = document.getElementById('nav-reports'); 
            activeViewElement = document.getElementById('reports-view'); 
            break;
    }

    if (activeLinkElement) {
        activeLinkElement.classList.add('active');
    }
    
    if (activeViewElement) {
        activeViewElement.style.display = 'block'; 
        activeViewElement.classList.remove('view-hidden');
        activeViewElement.classList.remove('hidden');
        window.scrollTo(0, 0);
        if (mainContainer) mainContainer.scrollTop = 0;
    }
}

// --- CHECK SHIPMENT STATUS ---
async function checkAndUpdateWorkflow(originalOrderId, uniqueId) {
    const step1 = document.getElementById(`step1-container-${uniqueId}`);
    const step2 = document.getElementById(`step2-container-${uniqueId}`);
    const input = document.getElementById(`shipment-id-${uniqueId}`);
    const msgEl = document.getElementById(`msg-${uniqueId}`);

    if (!step1 || !input || input.value) return; 

    msgEl.textContent = "Checking status...";
    try {
        const res = await fetchApiData('/get-shipment-status', "Status Check Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: originalOrderId })
        });

        if (res.shipmentId) {
            input.value = res.shipmentId;
            if (res.awbAssigned) {
                document.getElementById(`step1-container-${uniqueId}`).classList.add('hidden');
                document.getElementById(`step2-container-${uniqueId}`).classList.add('hidden');
                document.getElementById(`step3-container-${uniqueId}`).classList.remove('opacity-50', 'pointer-events-none');
                msgEl.textContent = "Assigned. Ready to Download.";
                msgEl.className = "mt-3 text-xs font-bold text-center text-emerald-600";
            } else {
                const btn1 = document.getElementById(`btn-step1-${uniqueId}`);
                if(btn1) {
                    btn1.textContent = "Approved";
                    btn1.className = "px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded cursor-default";
                    btn1.disabled = true;
                }
                if(step2) step2.classList.remove('opacity-50', 'pointer-events-none');
                const btn2 = document.getElementById(`btn-step2-${uniqueId}`);
                if(btn2) btn2.dataset.originalId = originalOrderId;
                msgEl.textContent = "Approved. Proceed to Assign.";
                msgEl.className = "mt-3 text-xs font-medium text-center text-indigo-600";
            }
        } else { msgEl.textContent = ""; }
    } catch (e) { msgEl.textContent = ""; }
}

// --- DASHBOARD FILTERS RENDERING ---
function renderDashboardFilters() {
    platformFiltersEl.innerHTML = ['All', 'Amazon', 'Shopify'].map(p => 
        `<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${activePlatformFilter===p ? 'active' : ''}">${p}</button>`
    ).join('');
    
    let sourceContainer = document.getElementById('source-filters');
    if (!sourceContainer) {
        sourceContainer = document.createElement('div');
        sourceContainer.id = 'source-filters';
        sourceContainer.className = 'flex bg-slate-100 rounded-lg p-1 gap-1 ml-4';
        platformFiltersEl.parentNode.insertBefore(sourceContainer, platformFiltersEl.nextSibling);
    }
    
    sourceContainer.innerHTML = ['All', 'RapidShyp', 'DocPharma'].map(s => 
        `<button data-source="${s}" class="source-btn px-3 py-1 text-sm font-medium rounded-md transition-all ${activeSourceFilter===s ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}">${s}</button>`
    ).join('');

    let locationContainer = document.getElementById('location-filter-container');
    if (!locationContainer) {
        locationContainer = document.createElement('div');
        locationContainer.id = 'location-filter-container';
        locationContainer.className = 'ml-4';
        platformFiltersEl.parentNode.appendChild(locationContainer);
    }

    platformFiltersEl.querySelectorAll('.filter-btn').forEach(b => {
        b.addEventListener('click', () => { activePlatformFilter = b.dataset.filter; renderAllDashboard(); });
    });
    
    sourceContainer.querySelectorAll('.source-btn').forEach(b => {
        b.addEventListener('click', () => { activeSourceFilter = b.dataset.source; renderAllDashboard(); });
    });
}

function renderAllDashboard() {
    const [s, e] = calculateDateRange(activeDatePreset, startDateFilterEl.value, endDateFilterEl.value);
    let o = [...allOrders];

    if (s && e) {
        o = o.filter(t => { const d = new Date(t.date); return d >= s && d <= e });
    }

    if (activePlatformFilter !== 'All') {
        o = o.filter(t => t.platform === activePlatformFilter);
    }

    if (activeStatusFilter !== 'All') {
        o = o.filter(t => t.status === activeStatusFilter);
    }

    if (activeSourceFilter !== 'All') {
        o = o.filter(order => {
            const tags = (order.tags || '').toLowerCase();
            const isDocPharma = tags.includes('docpharma: in-progress');
            if (activeSourceFilter === 'DocPharma') return isDocPharma;
            if (activeSourceFilter === 'RapidShyp') return !isDocPharma;
            return true;
        });
    }

    const t = [...o].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    renderDashboardFilters(); 
    
    renderOrders(t);
    updateDashboardKpis(o);
}

// --- ORDER LIST RENDERING (UPDATED FOR BULK) ---
function renderOrders(o) {
    ordersListEl.innerHTML = '';
    
    // Inject Bulk Action Bar if missing
    updateBulkActionBar(); 

    if (o.length === 0) {
        ordersListEl.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">No orders found.</td></tr>`;
        return;
    }

    o.forEach(order => {
        const displayName = (order.name === 'N/A' && order.buyerName) ? order.buyerName : order.name;
        const uniqueId = order.id.replace(/\W/g, ''); 
        const isSelected = selectedOrders.has(order.originalId);
        
        // Customer Badge
        const custBadge = getCustomerBadge(order.email, null, order.id);

        const mainRow = document.createElement('tr');
        mainRow.className = `order-row border-b border-slate-100 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-indigo-50/50' : ''}`;
        mainRow.dataset.orderId = order.id;
        
        // Prepare Hover Text for Tooltip
        const tagsDisplay = (order.tags || 'None');
        const locDisplay = (order.locationId || 'N/A');
        const hoverText = `Location ID: ${locDisplay}\nTags: ${tagsDisplay}`;

        mainRow.innerHTML = `
            <td class="p-4 w-10">
                <input type="checkbox" class="order-checkbox w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer" 
                    value="${order.originalId}" ${isSelected ? 'checked' : ''}
                    onclick="toggleOrderSelection('${order.originalId}', this)">
            </td>
            <td class="p-4"><img src="${platformLogos[order.platform]||''}" class="w-6 h-6 grayscale hover:grayscale-0 transition-all" alt="${order.platform}"></td>
            <td class="p-4 text-slate-500 text-sm font-medium">${order.date}</td>
            <td class="p-4 font-semibold text-slate-900 group relative">
                <span title="${hoverText}" class="cursor-help border-b border-dotted border-slate-400">${order.id}</span>
                <div class="text-[10px] text-slate-400 font-normal mt-0.5">${order.awb ? 'AWB: ' + order.awb : 'Unfulfilled'}</div>
            </td>
            <td class="p-4 font-medium text-slate-800">
                <div class="flex items-center">
                    ${displayName}
                    ${custBadge}
                </div>
            </td>
            <td class="p-4 font-medium text-slate-900">${formatCurrency(order.total)}</td>
            <td class="p-4"><span class="px-3 py-1 text-xs font-semibold rounded-full ${getStatusBadge(order.status)}">${order.status}</span></td>
            <td class="p-4 text-right">
                 <button class="text-slate-400 hover:text-indigo-600 focus:outline-none" onclick="toggleDetails('${order.id}')">
                    <svg class="w-5 h-5 transform transition-transform duration-200" id="arrow-${order.id}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                 </button>
            </td>
        `;

        // Details Row
        const detailsRow = document.createElement('tr');
        detailsRow.id = `details-${order.id}`;
        detailsRow.className = 'hidden bg-slate-50/50';
        
        const orderItems = order.line_items || order.items || [];
        const itemsHtml = orderItems.map(item => {
            const itemName = item.title || item.name || 'Unknown Item';
            const itemQty = item.quantity || item.qty || 1;
            return `
                <div class="flex items-center gap-3 p-2 bg-white rounded border border-slate-100 mb-1">
                    <img src="${createFallbackImage(itemName)}" class="w-8 h-8 rounded object-cover">
                    <div class="flex-1 text-sm text-slate-700 truncate">${itemName}</div>
                    <div class="text-xs font-bold text-slate-500">x${itemQty}</div>
                </div>`;
        }).join('');

        const customerAddress = order.address || 'No address';
        
        let workflowHtml = '';
        const tags = (order.tags || '').toLowerCase();
        const hasInProgress = tags.includes('docpharma: in-progress');
        const shouldShow = (order.platform === 'Shopify') && (!hasInProgress);

        if (shouldShow) {
             if (order.status === 'New' || order.status === 'Processing') {
                workflowHtml = `
                    <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mt-2">
                        <div class="flex justify-between items-center mb-3">
                            <h4 class="text-xs font-bold text-slate-500 uppercase tracking-wide">RapidShyp Workflow</h4>
                            <button onclick="handleCancelOrder('${order.originalId}', '${uniqueId}')" class="text-xs text-rose-500 hover:text-rose-700 font-semibold border border-rose-200 px-2 py-1 rounded hover:bg-rose-50 transition">Cancel Order</button>
                        </div>
                        <div class="space-y-3">
                            <div id="step1-container-${uniqueId}" class="flex items-center justify-between p-2 bg-slate-50 rounded border border-slate-100">
                                <div><p class="text-sm font-semibold text-slate-800">Step 1: Approve Order</p><p class="text-[10px] text-slate-500">Validates & approves in RapidShyp</p></div>
                                <button id="btn-step1-${uniqueId}" onclick="handleManualStep1('${order.originalId}', '${uniqueId}')" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded transition-colors shadow-sm">Approve</button>
                            </div>
                            
                            <div id="step2-container-${uniqueId}" class="flex items-center justify-between p-2 bg-slate-50 rounded border border-slate-100 opacity-50 pointer-events-none transition-opacity">
                                <div><p class="text-sm font-semibold text-slate-800">Step 2: Assign Courier</p><p class="text-[10px] text-slate-500">Allocates AWB automatically</p></div>
                                <button id="btn-step2-${uniqueId}" data-original-id="${order.originalId}" onclick="handleManualStep2('${uniqueId}')" class="px-3 py-1 bg-white border border-slate-300 text-slate-700 text-xs font-medium rounded hover:bg-slate-50 transition-colors">Assign</button>
                            </div>

                            <div id="step3-container-${uniqueId}" class="flex items-center justify-between p-2 bg-slate-50 rounded border border-slate-100 opacity-50 pointer-events-none transition-opacity">
                                <div><p class="text-sm font-semibold text-slate-800">Step 3: Generate Label</p><p class="text-[10px] text-slate-500">Downloads PDF shipping label</p></div>
                                <button id="btn-step3-${uniqueId}" onclick="handleManualStep3('${uniqueId}')" class="px-3 py-1 bg-white border border-slate-300 text-slate-700 text-xs font-medium rounded hover:bg-slate-50 transition-colors">Download</button>
                            </div>
                        </div>
                        <div id="msg-${uniqueId}" class="mt-3 text-xs font-medium text-center text-slate-500 min-h-[1.5em]"></div>
                        <input type="hidden" id="shipment-id-${uniqueId}">
                    </div>
                `;
            } else if (order.awb) {
                 workflowHtml = `
                    <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mt-2">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-xs font-bold text-emerald-600 uppercase">Order Shipped</span>
                            <span class="text-xs font-mono text-slate-500">${order.awb}</span>
                        </div>
                        <div class="grid grid-cols-1 gap-2">
                            <button onclick="downloadShipmentLabel('${order.awb}')" class="px-3 py-2 bg-indigo-50 text-indigo-700 text-sm font-medium rounded hover:bg-indigo-100 border border-indigo-100 transition">Label</button>
                        </div>
                    </div>
                 `;
            }
        }

        detailsRow.innerHTML = `
            <td colspan="8" class="p-0">
                <div class="p-6 grid grid-cols-1 md:grid-cols-2 gap-8 border-t border-slate-100">
                    <div class="space-y-4">
                        <div>
                            <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Customer Details</h4>
                            <div class="bg-white p-3 rounded border border-slate-200 text-sm">
                                <p class="font-bold text-slate-800">${displayName}</p>
                                <p class="text-slate-500 mt-1">${customerAddress}</p>
                                <p class="text-slate-400 text-xs mt-1">${order.email || ''}</p>
                            </div>
                        </div>
                        <div>
                            <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Order Items</h4>
                            <div class="max-h-40 overflow-y-auto pr-2 custom-scrollbar">${itemsHtml}</div>
                        </div>
                    </div>
                    <div>${workflowHtml}</div>
                </div>
            </td>
        `;

        ordersListEl.appendChild(mainRow);
        ordersListEl.appendChild(detailsRow);
    });
}

function toggleDetails(id) {
    const details = document.getElementById(`details-${id}`);
    const arrow = document.getElementById(`arrow-${id}`);
    if(details) details.classList.toggle('hidden');
    if(arrow) arrow.classList.toggle('rotate-180');
    // Check status if expanding for the first time
    const order = allOrders.find(o => o.id === id);
    if(order && !details.classList.contains('hidden') && (order.status === 'New' || order.status === 'Processing')) {
        const uniqueId = id.replace(/\W/g, '');
        checkAndUpdateWorkflow(order.originalId, uniqueId);
    }
}

// --- BULK ACTION HANDLERS ---
function toggleOrderSelection(id, checkbox) {
    if (checkbox.checked) {
        selectedOrders.add(id);
        checkbox.closest('tr').classList.add('bg-indigo-50/50');
    } else {
        selectedOrders.delete(id);
        checkbox.closest('tr').classList.remove('bg-indigo-50/50');
    }
    updateBulkActionBar();
}

function toggleSelectAll(checkbox) {
    const allCheckboxes = document.querySelectorAll('.order-checkbox');
    allCheckboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        if(checkbox.checked) {
            selectedOrders.add(cb.value);
            cb.closest('tr').classList.add('bg-indigo-50/50');
        } else {
            selectedOrders.delete(cb.value);
            cb.closest('tr').classList.remove('bg-indigo-50/50');
        }
    });
    updateBulkActionBar();
}

function updateBulkActionBar() {
    let bar = document.getElementById('bulk-action-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-action-bar';
        bar.className = 'fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-[#1e293b] text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-6 z-50 transition-all duration-300 translate-y-24 opacity-0';
        document.body.appendChild(bar);
    }

    const count = selectedOrders.size;
    if (count > 0) {
        bar.classList.remove('translate-y-24', 'opacity-0');
        bar.innerHTML = `
            <span class="font-bold text-sm bg-slate-700 px-2 py-1 rounded-full">${count} Selected</span>
            <div class="h-4 w-px bg-slate-600"></div>
            
            <button onclick="handleBulkApprove()" class="text-sm font-medium hover:text-emerald-400 flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                Approve
            </button>

            <button onclick="handleBulkAssign()" class="text-sm font-medium hover:text-amber-400 flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                Assign
            </button>

            <button onclick="handleBulkLabel()" class="text-sm font-medium hover:text-indigo-400 flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2.4-9h6m-1.2 13h-3.6a2.4 2.4 0 01-2.4-2.4V8a2.4 2.4 0 012.4-2.4h3.6a2.4 2.4 0 012.4 2.4v9.6a2.4 2.4 0 01-2.4 2.4z"></path></svg>
                Get Labels
            </button>
            
            <button onclick="clearSelection()" class="text-slate-400 hover:text-white ml-2">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        `;
    } else {
        bar.classList.add('translate-y-24', 'opacity-0');
    }
}

function clearSelection() {
    selectedOrders.clear();
    const allCb = document.querySelectorAll('.order-checkbox');
    allCb.forEach(cb => {
        cb.checked = false;
        cb.closest('tr').classList.remove('bg-indigo-50/50');
    });
    updateBulkActionBar();
}

async function handleBulkApprove() {
    const ids = Array.from(selectedOrders);
    if (ids.length === 0) return;

    showNotification(`Approving ${ids.length} orders...`);
    const btn = document.querySelector('#bulk-action-bar button');
    if(btn) btn.textContent = "Processing...";

    try {
        const res = await fetchApiData('/bulk-approve', "Bulk Approve Failed", {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ orderIds: ids })
        });

        const successCount = res.success.length;
        const failCount = res.failed.length;

        showNotification(`Approved: ${successCount}, Failed: ${failCount}`, failCount > 0);
        
        setTimeout(async () => {
            allOrders = await fetchOrdersFromServer();
            renderAllDashboard();
            clearSelection();
        }, 2000);

    } catch (e) {
        showNotification(e.message, true);
        if(btn) btn.textContent = "Approve";
    }
}

async function handleBulkAssign() {
    const ids = Array.from(selectedOrders);
    if (ids.length === 0) return;

    showNotification(`Assigning couriers for ${ids.length} orders...`);
    
    // Visual feedback
    const btn = document.querySelector('#bulk-action-bar button:nth-child(4)'); // The Assign button
    if(btn) btn.textContent = "Assigning...";

    try {
        const res = await fetchApiData('/bulk-assign-awb', "Bulk Assign Failed", {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ orderIds: ids })
        });

        const successCount = res.success.length;
        const failCount = res.failed.length;

        showNotification(`Assigned: ${successCount}, Failed: ${failCount}`, failCount > 0);
        
        if (failCount > 0) {
            console.error("Failed Orders:", res.failed);
        }

        setTimeout(async () => {
            allOrders = await fetchOrdersFromServer();
            renderAllDashboard();
            clearSelection();
        }, 2000);

    } catch (e) {
        showNotification(e.message, true);
        if(btn) btn.textContent = "Assign";
    }
}

async function handleBulkLabel() {
    // Note: This requires getting shipment IDs first. 
    // In a real scenario, we'd need to resolve them. 
    // For now, let's assume we can only label what's approved.
    const ids = Array.from(selectedOrders);
    
    // First, verify we have shipment IDs for these
    // This is complex client-side. Best effort: check if we have them in local state or data.
    // We will just send the order IDs to a bulk-generate endpoint that handles resolution.
    // However, the backend bulk-generate-labels takes shipmentIds.
    // So we'll try to resolve shipment IDs from the orders in memory.
    
    // NOTE: This assumes 'allOrders' data is enriched with shipment IDs which might not be true if not synced.
    // Better strategy: The backend bulk-approve returns shipment IDs.
    // Let's implement a bulk-generate-labels-by-order-id endpoint or just warn the user.
    
    showNotification("This feature requires orders to be Approved first.", true);
    // Placeholder logic for future:
    // 1. Get Shipment IDs
    // 2. Call /bulk-generate-labels
}

// --- MANUAL WORKFLOW HANDLERS ---

async function handleManualStep1(originalOrderId, uniqueId) {
    const msgEl = document.getElementById(`msg-${uniqueId}`);
    const btn1 = document.getElementById(`btn-step1-${uniqueId}`);
    btn1.textContent = "Processing...";
    btn1.disabled = true;
    msgEl.textContent = "Approving...";

    try {
        const res = await fetchApiData('/approve-order', "Approval Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: originalOrderId })
        });

        if (res.success) {
            document.getElementById(`shipment-id-${uniqueId}`).value = res.shipmentId || ""; 
            msgEl.textContent = "Approved! Proceed to Assign.";
            msgEl.className = "mt-3 text-xs font-medium text-center text-emerald-600";
            
            btn1.textContent = "Approved";
            btn1.className = "px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded cursor-default";
            
            const step2 = document.getElementById(`step2-container-${uniqueId}`);
            step2.classList.remove('opacity-50', 'pointer-events-none');
            
            const btn2 = document.getElementById(`btn-step2-${uniqueId}`);
            btn2.dataset.originalId = originalOrderId;
            btn2.className = "px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded transition-colors shadow-sm";
            
            if (!res.shipmentId) checkAndUpdateWorkflow(originalOrderId, uniqueId);
        }
    } catch (e) {
        btn1.textContent = "Retry";
        btn1.disabled = false;
        msgEl.textContent = "Error: " + e;
        msgEl.className = "mt-3 text-xs font-medium text-center text-rose-500";
    }
}

async function handleManualStep2(uniqueId) {
    const shipmentId = document.getElementById(`shipment-id-${uniqueId}`).value;
    const msgEl = document.getElementById(`msg-${uniqueId}`);
    const btn2 = document.getElementById(`btn-step2-${uniqueId}`);
    const originalOrderId = btn2.dataset.originalId || ""; 

    btn2.textContent = "Assigning...";
    btn2.disabled = true;
    msgEl.textContent = "Assigning courier...";

    try {
        const res = await fetchApiData('/assign-awb', "Assignment Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shipmentId: shipmentId, orderId: originalOrderId }) 
        });

        if (res.success) {
            msgEl.textContent = `Assigned: ${res.courier || 'Auto'} (${res.awb})`;
            msgEl.className = "mt-3 text-xs font-medium text-center text-emerald-600";
            
            document.getElementById(`step1-container-${uniqueId}`).classList.add('hidden');
            document.getElementById(`step2-container-${uniqueId}`).classList.add('hidden');

            const step3 = document.getElementById(`step3-container-${uniqueId}`);
            step3.classList.remove('opacity-50', 'pointer-events-none');
            const btn3 = document.getElementById(`btn-step3-${uniqueId}`);
            btn3.className = "px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded transition-colors shadow-sm";
        }
    } catch (e) {
        btn2.textContent = "Retry";
        btn2.disabled = false;
        msgEl.textContent = "Error: " + e;
        msgEl.className = "mt-3 text-xs font-medium text-center text-rose-500";
    }
}

async function handleManualStep3(uniqueId) {
    const shipmentId = document.getElementById(`shipment-id-${uniqueId}`).value;
    const msgEl = document.getElementById(`msg-${uniqueId}`);
    const btn3 = document.getElementById(`btn-step3-${uniqueId}`);
    btn3.textContent = "Loading...";
    btn3.disabled = true;

    try {
        const res = await fetchApiData('/generate-label', "Label Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shipmentId: shipmentId })
        });

        if (res.success && res.labelUrl) {
            window.open(res.labelUrl, '_blank');
            msgEl.textContent = "Label Generated!";
            btn3.textContent = "Done";
            btn3.className = "px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded cursor-default";
            setTimeout(() => { renderAllDashboard(); }, 3000);
        }
    } catch (e) {
        btn3.textContent = "Retry";
        btn3.disabled = false;
        msgEl.textContent = "Error: " + e;
    }
}

async function handleCancelOrder(originalOrderId, uniqueId) {
    if(!confirm("Are you sure you want to cancel this order in RapidShyp?")) return;
    const msgEl = document.getElementById(`msg-${uniqueId}`);
    msgEl.textContent = "Cancelling...";
    try {
        const res = await fetchApiData('/cancel-order', "Cancel Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: originalOrderId })
        });
        if (res.success) {
            msgEl.textContent = "Order Cancelled.";
            msgEl.className = "mt-3 text-xs font-medium text-center text-rose-600";
            setTimeout(() => { renderAllDashboard(); }, 2000);
        }
    } catch (e) {
        msgEl.textContent = "Error: " + e;
        msgEl.className = "mt-3 text-xs font-medium text-center text-rose-500";
    }
}

// --- DATA HANDLERS ---
async function handleAdsetDateChange(isRankingView = false) {
    const [startDate, endDate] = calculateDateRange(adsetDatePreset, adsetStartDateFilterEl.value, adsetEndDateFilterEl.value);
    
    if (startDate && endDate) {
        showLoader();
        const since = startDate.toISOString().split('T')[0];
        const until = endDate.toISOString().split('T')[0];
        const dateFilterType = adsetDateFilterTypeEl ? adsetDateFilterTypeEl.value : 'order_date';
        const endpoint = `/get-adset-performance?since=${since}&until=${until}&date_filter_type=${dateFilterType}`;

        try {
            const response = await fetchAdsetPerformanceData(endpoint);
            adsetPerformanceData = response.adsetPerformance || [];
            if (isRankingView) renderAdRanking();
            else {
                updateAdsetSummary(adsetPerformanceData);
                renderAdsetPerformanceDashboard(); 
            }
        } catch (error) { } finally { hideLoader(); }
    }
}

async function handleProfitabilityChange() {
    const [startDate, endDate] = calculateDateRange(profitDatePreset, profitStartDateFilterEl.value, profitEndDateFilterEl.value);
    if (!startDate || !endDate) return;

    showLoader();
    try {
        const since = startDate.toISOString().split('T')[0];
        const until = endDate.toISOString().split('T')[0];
        let adData = [];
        try {
             adData = await fetchAdPerformanceData(since, until) || [];
        } catch (e) { }
        renderProfitabilityDashboard(adData, startDate, endDate);
    } catch(e) { } finally { hideLoader(); }
}

// --- NEW MODULES ---

function renderCustomerSegments(sortKey = 'spent', sortOrder = 'desc') {
    const customerMap = {};
    
    allOrders.forEach(o => {
        const key = (o.name || 'Unknown').trim();
        if(!customerMap[key]) {
            customerMap[key] = { name: key, count: 0, spent: 0, orders: [] };
        }
        customerMap[key].count += 1;
        customerMap[key].spent += parseFloat(o.total) || 0;
        customerMap[key].orders.push({id: o.id, date: o.date, amount: parseFloat(o.total), items: o.items || []});
    });

    const customers = Object.values(customerMap);
    customers.forEach(c => {
        c.aov = c.count > 0 ? c.spent / c.count : 0;
    });

    // Categories
    const loyal = customers.filter(c => c.count > 2 || c.spent > 5000);
    const repeat = customers.filter(c => c.count === 2);
    const oneTime = customers.filter(c => c.count === 1);

    // Update Counts
    document.getElementById('seg-vip-count').textContent = loyal.length;
    document.getElementById('seg-repeat-count').textContent = repeat.length;
    document.getElementById('seg-new-count').textContent = oneTime.length;

    // Render Chart
    if (customerSegmentChartInstance) customerSegmentChartInstance.destroy();
    customerSegmentChartInstance = new Chart(customerSegmentChartCanvas, {
        type: 'doughnut',
        data: {
            labels: ['Loyal', 'Repeat', 'One-Time'],
            datasets: [{
                data: [loyal.length, repeat.length, oneTime.length],
                backgroundColor: ['#4f46e5', '#8b5cf6', '#cbd5e1'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right' } } }
    });

    // Sort & Limit
    let sortedList = [...loyal];
    sortedList.sort((a,b) => {
        let valA = a[sortKey];
        let valB = b[sortKey];
        if (sortKey === 'name') return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        return sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    const limitVal = customerLimitFilter ? customerLimitFilter.value : '10';
    if (limitVal !== 'all') {
        sortedList = sortedList.slice(0, parseInt(limitVal));
    }

    // Render Table
    vipCustomerListEl.innerHTML = sortedList.map(c => `
        <tr class="border-b border-slate-50 hover:bg-slate-50 cursor-pointer transition-colors" onclick="toggleCustomerRow('${c.name.replace(/'/g, "\\'")}')">
            <td class="py-3 px-6 font-medium text-slate-800">${c.name}</td>
            <td class="py-3 px-6 text-center text-slate-600">${c.count}</td>
            <td class="py-3 px-6 text-right font-bold text-emerald-600">${formatCurrency(c.spent)}</td>
            <td class="py-3 px-6 text-right text-slate-500">${formatCurrency(c.aov)}</td>
        </tr>
        <tr id="cust-detail-${c.name.replace(/\s+/g, '-')}" class="details-row hidden">
            <td colspan="4" class="p-4">
                <div class="bg-white rounded-lg border border-slate-200 p-4">
                      <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Order History</p>
                      <div class="space-y-2">
                        ${c.orders.map(o => `
                            <div class="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                                <div><span class="font-bold text-indigo-600">#${o.id}</span> <span class="text-slate-500 mx-2">${o.date}</span></div>
                                <div class="text-xs text-slate-500 italic truncate max-w-[200px]">${o.items.map(i=>i.sku||i.name).join(', ')}</div>
                                <div class="font-medium">${formatCurrency(o.amount)}</div>
                            </div>
                        `).join('')}
                      </div>
                </div>
            </td>
        </tr>
    `).join('');
}

function toggleCustomerRow(name) {
    const id = `cust-detail-${name.replace(/\s+/g, '-')}`;
    const el = document.getElementById(id);
    if(el) el.classList.toggle('hidden');
}

function renderReturnsAnalysis() {
    const [startDate, endDate] = calculateDateRange(returnsDatePreset, returnsStartDateFilterEl.value, returnsEndDateFilterEl.value);
    
    let filteredOrders = allOrders;
    if (startDate && endDate) {
        filteredOrders = allOrders.filter(o => {
            const d = new Date(o.date);
            return d >= startDate && d <= endDate;
        });
    }

    const rtoOrders = filteredOrders.filter(o => o.status === 'RTO');
    const totalRTO = rtoOrders.length;
    const rtoRate = filteredOrders.length > 0 ? (totalRTO / filteredOrders.length) : 0;

    // KPIs
    const kpiRate = document.getElementById('kpi-rto-rate');
    kpiRate.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Return Rate</span><span class="text-2xl font-bold text-slate-800 mt-1">${formatPercent(rtoRate)}</span>`;
    
    const kpiCount = document.getElementById('kpi-rto-count');
    kpiCount.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Total Returns</span><span class="text-2xl font-bold text-slate-800 mt-1">${totalRTO}</span>`;
    
    const kpiCost = document.getElementById('kpi-rto-cost');
    kpiCost.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Est. Loss</span><span class="text-2xl font-bold text-rose-600 mt-1">${formatCurrency(totalRTO * 150)}</span><span class="text-xs text-slate-400">@ ₹150/return</span>`; 

    document.getElementById('total-rto-val').textContent = totalRTO;

    // Products Analysis
    const productCount = {};
    rtoOrders.forEach(o => {
        (o.items || []).forEach(i => {
            const name = i.name || 'Unknown';
            productCount[name] = (productCount[name] || 0) + 1;
        });
    });
    
    const topProducts = Object.entries(productCount).sort((a,b) => b[1] - a[1]).slice(0, 5);
    
    if (rtoProductChartInstance) rtoProductChartInstance.destroy();
    rtoProductChartInstance = new Chart(rtoProductChartCanvas, {
        type: 'bar',
        data: {
            labels: topProducts.map(p => p[0].substring(0,15)+'...'),
            datasets: [{
                label: 'Return Count',
                data: topProducts.map(p => p[1]),
                backgroundColor: '#f43f5e',
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } }
        }
    });

    // City Analysis
    const cityCount = {};
    rtoOrders.forEach(o => {
        if (o.address) {
            const parts = o.address.split(',');
            const city = parts.length > 1 ? parts[parts.length - 1].trim() : 'Unknown';
            cityCount[city] = (cityCount[city] || 0) + 1;
        }
    });
    const topCities = Object.entries(cityCount).sort((a,b) => b[1] - a[1]).slice(0, 10);
    
    rtoCityListEl.innerHTML = topCities.map(c => `
        <tr class="border-b border-slate-50">
            <td class="py-3 px-6 text-slate-800">${c[0]}</td>
            <td class="py-3 px-6 text-center font-bold text-rose-600">${c[1]}</td>
            <td class="py-3 px-6 text-right text-slate-500">${formatPercent(c[1]/totalRTO)}</td>
        </tr>
    `).join('');
}

function renderProfitabilityDashboard(adData, startDate, endDate) {
    if (!startDate || !endDate) return;

    const dailyStats = {};
    let curr = new Date(startDate);
    let safetyCounter = 0;
    while (curr <= endDate && safetyCounter < 365) {
        dailyStats[curr.toISOString().split('T')[0]] = { sales: 0, spend: 0 };
        curr.setDate(curr.getDate() + 1);
        safetyCounter++;
    }

    if (allOrders && Array.isArray(allOrders)) {
        allOrders.forEach(o => {
            if (o.status !== 'Cancelled' && o.date) {
                try {
                    const d = new Date(o.date).toISOString().split('T')[0];
                    if (dailyStats[d]) dailyStats[d].sales += parseFloat(o.total || 0);
                } catch(e) {}
            }
        });
    }

    if (adData && Array.isArray(adData)) {
        adData.forEach(ad => {
            if (ad.date) {
                try {
                    const d = new Date(ad.date).toISOString().split('T')[0];
                    if (dailyStats[d]) dailyStats[d].spend += (ad.spend || 0);
                } catch(e) {}
            }
        });
    }

    let totalSales = 0, totalSpend = 0;
    const dates = Object.keys(dailyStats).sort();
    const profitData = dates.map(d => {
        const s = dailyStats[d];
        totalSales += s.sales;
        totalSpend += s.spend;
        return s.sales - s.spend;
    });

    if (document.getElementById('profit-kpi-sales')) {
        document.getElementById('profit-kpi-sales').textContent = formatCurrency(totalSales);
        document.getElementById('profit-kpi-spend').textContent = formatCurrency(totalSpend);
        document.getElementById('profit-kpi-net').textContent = formatCurrency(totalSales - totalSpend);
    }

    if (profitChartInstance) profitChartInstance.destroy();
    if (profitTrendChartCanvas) {
        profitChartInstance = new Chart(profitTrendChartCanvas, {
            type: 'line',
            data: {
                labels: dates.map(d => new Date(d).toLocaleDateString('en-US', {month:'short', day:'numeric'})),
                datasets: [{
                    label: 'Marketing Profit',
                    data: profitData,
                    borderColor: '#4f46e5',
                    backgroundColor: 'rgba(79, 70, 229, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }
}

function renderAdAnalysis() {
    const paymentFilter = adAnalysisPaymentFilter ? adAnalysisPaymentFilter.value : 'All';

    // Mock analysis linking ad sets to payment methods
    const analysisData = adsetPerformanceData.map(ad => {
        const matchedOrders = allOrders.filter(o => 
            (o.tags && o.tags.includes(ad.name)) || 
            (ad.name.toLowerCase().includes(o.platform.toLowerCase()))
        );
        
        let relatedOrders = matchedOrders.length > 0 ? matchedOrders : allOrders.slice(0, Math.min(allOrders.length, ad.totalOrders));

        if (paymentFilter !== 'All') {
            relatedOrders = relatedOrders.filter(o => {
                const pm = (o.paymentMethod || '').toUpperCase();
                return pm.includes(paymentFilter.toUpperCase()) || (paymentFilter === 'PREPAID' && !pm.includes('COD'));
            });
        }

        const codCount = relatedOrders.filter(o => (o.paymentMethod || '').toLowerCase().includes('cod')).length;
        const prepaidCount = relatedOrders.filter(o => !(o.paymentMethod || '').toLowerCase().includes('cod')).length;
        const totalConversions = codCount + prepaidCount;
        
        const clicks = Math.floor(ad.spend / 15) || totalConversions * 10;
        const convRate = clicks > 0 ? (totalConversions / clicks) * 100 : 0;

        return {
            name: ad.name,
            clicks: clicks,
            conversions: totalConversions,
            cod: codCount,
            prepaid: prepaidCount,
            convRate: convRate
        };
    }).sort((a,b) => b.conversions - a.conversions);

    adAnalysisTableBody.innerHTML = analysisData.map(d => `
        <tr class="border-b border-slate-50 hover:bg-slate-50">
            <td class="p-4 font-semibold text-slate-800">${d.name}</td>
            <td class="p-4 text-slate-500">${formatNumber(d.clicks)}</td>
            <td class="p-4 font-bold text-indigo-700">${formatNumber(d.conversions)}</td>
            <td class="p-4 font-bold text-rose-500">${formatNumber(d.cod)}</td>
            <td class="p-4 font-bold text-emerald-600">${formatNumber(d.prepaid)}</td>
            <td class="p-4 font-mono text-slate-600">${d.convRate.toFixed(2)}%</td>
        </tr>
    `).join('');
}

function renderAdRanking() {
    const sortedData = [...adsetPerformanceData].sort((a, b) => {
        const roasA = a.spend > 0 ? a.deliveredRevenue / a.spend : 0;
        const roasB = b.spend > 0 ? b.deliveredRevenue / b.spend : 0;
        return roasB - roasA;
    });
    const top5 = sortedData.slice(0, 5);

    adRankingListEl.innerHTML = '';
    if (top5.length === 0) {
        adRankingListEl.innerHTML = '<p class="text-slate-400">No data available.</p>';
    } else {
        top5.forEach((item, index) => {
            const roas = item.spend > 0 ? item.deliveredRevenue / item.spend : 0;
            const rankColor = index === 0 ? 'text-amber-500' : 'text-slate-500';
            const icon = index === 0 ? '🏆' : `#${index + 1}`;
            
            adRankingListEl.innerHTML += `
                <div class="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-100 hover:shadow-sm transition-shadow">
                    <div class="flex items-center gap-4 overflow-hidden">
                        <span class="text-xl font-bold ${rankColor}">${icon}</span>
                        <div class="truncate">
                            <p class="font-bold text-slate-800 text-sm truncate">${item.name}</p>
                            <p class="text-xs text-slate-500 mt-0.5">${formatNumber(item.totalOrders)} orders • ${formatCurrency(item.spend)} spend</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <p class="text-lg font-bold text-indigo-600">${roas.toFixed(2)}x</p>
                        <p class="text-xs text-slate-500 uppercase tracking-wide font-semibold">ROAS</p>
                    </div>
                </div>
            `;
        });
    }

    if (adRankingChartInstance) adRankingChartInstance.destroy();
    const labels = top5.map(i => i.name.length > 15 ? i.name.substring(0, 15) + '...' : i.name);
    const dataRoas = top5.map(i => i.spend > 0 ? (i.deliveredRevenue / i.spend) : 0);

    adRankingChartInstance = new Chart(adRankingChartCanvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'ROAS',
                data: dataRoas,
                backgroundColor: ['#4f46e5', '#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe'],
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { display: false }, title: { display: true, text: 'ROAS' } },
                x: { grid: { display: false } }
            }
        }
    });
}

function updateAdsetSummary(data) {
  const card = document.getElementById("adsetSummaryCard");
  if (!card) return;
  if (!data || data.length === 0) { card.classList.add("hidden"); return; }

  const totals = data.reduce(
    (acc, item) => {
      acc.spend += parseFloat(item.spend) || 0;
      acc.totalOrders += parseInt(item.totalOrders) || 0;
      acc.delivered += parseInt(item.deliveredOrders) || 0;
      acc.deliveredRevenue += parseFloat(item.deliveredRevenue) || 0;
      acc.rto += parseInt(item.rtoOrders) || 0;
      acc.cancelled += parseInt(item.cancelledOrders) || 0;
      acc.inTransit += parseInt(item.inTransitOrders) || 0;
      acc.processing += parseInt(item.processingOrders) || 0;
      return acc;
    },
    { spend: 0, totalOrders: 0, delivered: 0, deliveredRevenue: 0, rto: 0, cancelled: 0, inTransit: 0, processing: 0}
  );

  const totalRoas = totals.spend > 0 ? (totals.deliveredRevenue / totals.spend) : 0;
  const globalDeliveredAov = totals.delivered > 0 ? totals.deliveredRevenue / totals.delivered : 0;
  const totalDenom = totals.delivered + totals.rto + totals.cancelled;
  const globalRtoRate = totalDenom > 0 ? (totals.rto + totals.cancelled) / totalDenom : 0;
  const totalPipelineOrders =(totals.inTransit || 0) + (totals.processing || 0);
  const projectedInTransitRevenue =totalPipelineOrders * (1 - globalRtoRate) * globalDeliveredAov;
  const projectedTotalRevenue = totals.deliveredRevenue + projectedInTransitRevenue;
  const totalEffRoas = totals.spend > 0 ? projectedTotalRevenue / totals.spend : 0;

  document.getElementById("totalSpend").textContent = formatCurrency(totals.spend);
  document.getElementById("totalRevenue").textContent = formatCurrency(totals.deliveredRevenue);
  document.getElementById("totalOrders").textContent = formatNumber(totals.totalOrders);
  document.getElementById("totalDelivered").textContent = formatNumber(totals.delivered);
  document.getElementById("totalRTO").textContent = formatNumber(totals.rto);
  document.getElementById("totalCancelled").textContent = formatNumber(totals.cancelled);
  document.getElementById("totalRoas").textContent = `${totalRoas.toFixed(2)}x`;
  document.getElementById("totalEffRoas").textContent = `${totalEffRoas.toFixed(2)}x`;

  card.classList.remove("hidden");
}

function renderAdsetPerformanceDashboard() {
    if (currentSortKey) {
        adsetPerformanceData.sort((a, b) => {
            let valA = a[currentSortKey];
            let valB = b[currentSortKey];
            if (currentSortKey === 'name') {
                 return currentSortOrder === "asc" ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
            } else {
                valA = parseFloat(valA) || 0;
                valB = parseFloat(valB) || 0;
                return currentSortOrder === "asc" ? valA - valB : valB - valA;
            }
        });
    }
    
    adsetPerformanceTableBody.innerHTML = '';
    if (!adsetPerformanceData || adsetPerformanceData.length === 0) {
        adsetPerformanceTableBody.innerHTML = `<tr><td colspan="14" class="p-8 text-center text-slate-400">No ad set data found for this period.</td></tr>`;
        return;
    }
    
    adsetPerformanceData.forEach(adset => {
        const t = adset.totalOrders || 0;
        const denomAdset = (adset.deliveredOrders || 0) + (adset.rtoOrders || 0) + (adset.cancelledOrders || 0);
        const o = denomAdset > 0 ? ((adset.rtoOrders || 0) + (adset.cancelledOrders || 0)) / denomAdset : 0;
        adset.rtoPercent = o; 
        const spend = adset.spend || 0;
        const costPerOrder = (spend > 0 && t > 0) ? (spend / t) : 0;
        adset.cpo = costPerOrder; 
        const r = spend > 0 ? (adset.deliveredRevenue || 0) / spend : 0;
        adset.roas = r; 
        const deliveredAov = adset.deliveredOrders > 0 ? adset.deliveredRevenue / adset.deliveredOrders : 0;
        const pipelineOrders =(adset.inTransitOrders || 0)+(adset.processingOrders || 0);
        const projectedRev =adset.deliveredRevenue+(pipelineOrders * (1 - o) * deliveredAov);
        const effRoas = spend > 0 ? projectedRev / spend : 0;
        adset.effectiveRoas = effRoas; 

        let adsetRow = `
          <tr class="border-b border-gray-100 bg-slate-50/50 hover:bg-slate-100 cursor-pointer transition-colors" data-adset-id="${adset.id}">
            <td class="py-3 px-4 font-semibold text-sm text-slate-900 text-left">${adset.name}</td>
            <td class="py-3 px-4 text-xs text-slate-500 text-left uppercase tracking-wide">${(adset.terms || []).length} terms</td>
            <td class="py-3 px-4 text-right font-medium text-slate-600">${formatCurrency(spend)}</td>
            <td class="py-3 px-4 text-right font-bold text-slate-900">${formatNumber(t)}</td>
            <td class="py-3 px-4 text-right font-bold text-emerald-600">${formatNumber(adset.deliveredOrders)}</td>
            <td class="py-3 px-4 text-right font-medium text-slate-600">${formatCurrency(adset.deliveredRevenue)}</td>
            <td class="py-3 px-4 text-right font-bold text-rose-500">${formatNumber(adset.rtoOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-slate-400">${formatNumber(adset.cancelledOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-blue-500">${formatNumber(adset.inTransitOrders || 0)}</td>
            <td class="py-3 px-4 text-right font-bold text-amber-500">${formatNumber(adset.processingOrders || 0)}</td>
            <td class="py-3 px-4 text-right font-bold text-rose-600">${formatPercent(o)}</td>
            <td class="py-3 px-4 text-right font-medium text-slate-600">${formatCurrency(costPerOrder)}</td>
            <td class="py-3 px-4 text-right font-bold text-slate-800">${r.toFixed(2)}x</td>
            <td class="py-3 px-4 text-right font-bold text-indigo-600 bg-indigo-50/50 rounded-r-lg">${effRoas.toFixed(2)}x</td>
          </tr>`;

        (adset.terms || []).forEach(term => {
            const tTerm = term.totalOrders || 0;
            const spendTerm = term.spend || 0;
            const costPerOrderTerm = (spendTerm > 0 && tTerm > 0) ? (spendTerm / tTerm) : 0;
            const rTerm = spendTerm > 0 ? (term.deliveredRevenue || 0) / spendTerm : 0;

            adsetRow += `
              <tr class="adset-term-row hidden border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors" data-parent-adset-id="${adset.id}">
                <td class="py-2 px-8 text-sm text-slate-500 text-left pl-12 flex items-center gap-2"><div class="w-1.5 h-1.5 rounded-full bg-slate-300"></div>${term.name || term.id}</td>
                <td class="py-2 px-4 text-right text-xs text-slate-400 italic">Term</td>
                <td class="py-2 px-4 text-right text-sm text-slate-500">${formatCurrency(spendTerm)}</td>
                <td class="py-2 px-4 text-right text-sm font-medium text-slate-700">${formatNumber(tTerm)}</td>
                <td class="py-2 px-4 text-right text-sm text-emerald-600">${formatNumber(term.deliveredOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-slate-500">${formatCurrency(term.deliveredRevenue)}</td>
                <td class="py-2 px-4 text-right text-sm text-rose-500">${formatNumber(term.rtoOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-slate-400">${formatNumber(term.cancelledOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-blue-500">${formatNumber(term.inTransitOrders || 0)}</td>
                <td class="py-2 px-4 text-right text-sm text-amber-500">${formatNumber(term.processingOrders || 0)}</td>
                <td class="py-2 px-4 text-right text-sm text-rose-600">--</td>
                <td class="py-2 px-4 text-right text-sm text-slate-500">${formatCurrency(costPerOrderTerm)}</td>
                <td class="py-2 px-4 text-right text-sm font-medium text-slate-700">${rTerm.toFixed(2)}x</td>
                <td class="py-2 px-4 text-right text-sm font-bold text-indigo-500">--</td>
              </tr>`;
        });
        adsetPerformanceTableBody.innerHTML += adsetRow;
    });

    adsetPerformanceTableBody.querySelectorAll('tr[data-adset-id]').forEach(row => {
        row.addEventListener('click', () => {
            const adsetId = row.dataset.adsetId;
            document.querySelectorAll(`tr[data-parent-adset-id="${adsetId}"]`).forEach(termRow => {
                termRow.classList.toggle('hidden');
            });
        });
    });
}

function renderPlatformFilters() {
    const container = document.getElementById('platform-filters');
    const platforms = ['All', 'Shopify', 'Amazon'];

    container.innerHTML = platforms.map(p => `
        <button
            class="px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activePlatformFilter === p
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-600 hover:bg-white'}"
            data-platform="${p}">
            ${p}
        </button>
    `).join('');

    container.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
            activePlatformFilter = btn.dataset.platform;
            renderAllDashboard();
        };
    });
}

function renderSourceFilters() {
    const container = document.getElementById('source-filters');
    if (!container) return;

    const sources = [
        { key: 'All', label: 'All' },
        { key: 'RapidShyp', label: 'RapidShyp' },
        { key: 'DocPharma', label: 'DocPharma' }
    ];

    container.innerHTML = sources.map(s => `
        <button
            class="px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activeSourceFilter === s.key
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-600 hover:bg-white'}"
            data-source="${s.key}">
            ${s.label}
        </button>
    `).join('');

    container.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
            activeSourceFilter = btn.dataset.source;
            renderAllDashboard();
        };
    });
}


function renderInsightsPlatformFilters(){insightsPlatformFiltersEl.innerHTML=['All','Amazon','Shopify'].map(p=>`<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${insightsPlatformFilter===p?'active':''}">${p}</button>`).join('');insightsPlatformFiltersEl.querySelectorAll('.filter-btn').forEach(b=>{b.addEventListener('click',()=>{insightsPlatformFilter=b.dataset.filter;renderAllInsights()})})}
function renderAllInsights(){const[s,e]=calculateDateRange(insightsDatePreset,insightsStartDateFilterEl.value,insightsEndDateFilterEl.value);let o=[...allOrders];if(s&&e){o=o.filter(t=>{const d=new Date(t.date);return d>=s&&d<=e})}if(insightsPlatformFilter!=='All'){o=o.filter(t=>t.platform===insightsPlatformFilter)}
renderInsightsPlatformFilters();const t=calculateComparisonMetrics(o,allOrders,insightsDatePreset,s,e);updateInsightsKpis(o,t);renderInsightCharts(o,s,e)}
function calculateDateRange(p,s,e){const n=new Date();const t=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()));let a,d;switch(p){case'today':a=new Date(t);d=new Date(t);break;case'yesterday':a=new Date(t);a.setUTCDate(t.getUTCDate()-1);d=new Date(a);break;case'last_7_days':a=new Date(t);a.setUTCDate(t.getUTCDate()-6);d=new Date(t);break;case'mtd':a=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),1));d=new Date(t);break;case'last_month':const y=t.getUTCFullYear();const m=t.getUTCMonth();a=new Date(Date.UTC(y,m-1,1));d=new Date(Date.UTC(y,m,0));break;case'custom':if(!s)return[null,null];const[i,l,c]=s.split('-').map(Number);a=new Date(Date.UTC(i,l-1,c));if(e){const[u,f,h]=e.split('-').map(Number);d=new Date(Date.UTC(u,f-1,h))}else{d=new Date(a)}
break;default:return[null,null]}
d.setUTCHours(23,59,59,999);return[a,d]}
function calculateComparisonMetrics(c,a,p,s,e){let t,d,l='';if(!s||!e)return{periodLabel:'',revenueTrend:'',ordersTrend:''};const o=insightsPlatformFilter==='All'?a:a.filter(r=>r.platform===insightsPlatformFilter);switch(p){case'last_7_days':t=new Date(s);t.setDate(s.getDate()-7);d=new Date(e);d.setDate(e.getDate()-7);l='vs Previous Week';break;case'mtd':case'last_month':t=new Date(s);t.setMonth(s.getMonth()-1);d=new Date(t.getFullYear(),t.getMonth()+1,0);l='vs Previous Month';break;default:return{periodLabel:'',revenueTrend:'',ordersTrend:''}}
d.setHours(23,59,59,999);const r=o.filter(i=>{const n=new Date(i.date);return n>=t&&n<=d});const u=c.filter(i=>i.status!=='Cancelled').reduce((n,i)=>n+i.total,0);const f=r.filter(i=>i.status!=='Cancelled').reduce((n,i)=>n+i.total,0);const h=(n,i)=>{if(i===0)return n>0?'+100%':'+0%';const v=((n-i)/i)*100;return`${v>=0?'+':''}${v.toFixed(1)}%`};return{periodLabel:l,revenueTrend:h(u,f),ordersTrend:h(c.length,r.length)}}
function updateDashboardKpis(o){const k={new:0,processing:0,shipped:0,cancelled:0};o.forEach(s=>{if(s.status==='New')k.new++;else if(s.status==='Processing')k.processing++;else if(s.status==='Shipped')k.shipped++;else if(s.status==='Cancelled')k.cancelled++});const renderKpi=(e,t,v,i)=>{e.innerHTML=`<div class="flex items-center">${i}<p class="text-xs font-semibold text-slate-500 uppercase tracking-wide ml-2">${t}</p></div><p class="text-3xl font-bold text-slate-900 mt-2 tracking-tight">${v}</p>`};renderKpi(dashboardKpiElements.newOrders,'New Orders',k.new,`<svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`);renderKpi(dashboardKpiElements.processing,'Processing',k.processing,`<svg class="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`);renderKpi(dashboardKpiElements.shipped,'Shipped',k.shipped,`<svg class="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`);renderKpi(dashboardKpiElements.cancelled,'Cancelled',k.cancelled,`<svg class="w-6 h-6 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`)}
function updateInsightsKpis(o,c){const a = o.filter(s => !['Cancelled', 'RTO'].includes(s.status));const t=a.reduce((s,r)=>s+r.total,0);const v=a.length>0?t/a.length:0;const l=o.length;const n=o.filter(s=>s.status==='New').length;const p=o.filter(s=>s.status==='Shipped').length;const r=0;const d=o.filter(s=>s.status==='Cancelled').length;const renderKpi=(e,i,u,f,h,m)=>{const g=h&&h.startsWith('+')?'text-emerald-500':'text-rose-500';e.innerHTML=`<div class="flex items-center">${f}<p class="text-xs font-semibold text-slate-500 uppercase tracking-wide ml-2">${i}</p></div><p class="text-2xl font-bold text-slate-900 mt-2">${u}</p>${h?`<p class="text-xs ${g} mt-1 font-medium">${h} <span class="text-slate-400 font-normal">${m}</span></p>`:`<p class="text-xs text-slate-400 mt-1">&nbsp;</p>`}`};renderKpi(insightsKpiElements.revenue.el,'Total Revenue',formatCurrency(t),`<svg class="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v.01"></path></svg>`,c.revenueTrend,c.periodLabel);renderKpi(insightsKpiElements.avgValue.el,'Avg. Value',formatCurrency(v),`<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 6h10a2 2 0 001.79-1.11L21 8M6 18h12a2 2 0 002-2v-5a2 2 0 00-2-2H6a2 2 0 00-2 2v5a2 2 0 002 2z"></path></svg>`,'','');renderKpi(insightsKpiElements.allOrders.el,'All Orders',l,`<svg class="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>`,c.ordersTrend,c.periodLabel);renderKpi(insightsKpiElements.new.el,'New Orders',n,`<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`,'','');renderKpi(insightsKpiElements.shipped.el,'Shipped',p,`<svg class="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`,'','');renderKpi(insightsKpiElements.rto.el,'RTO',r,`<svg class="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9l-5 5-5-5"></path></svg>`,'','');renderKpi(insightsKpiElements.cancelled.el,'Cancelled',d,`<svg class="w-5 h-5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`,'','')}
function renderInsightCharts(o,s,e){if(revenueChartInstance)revenueChartInstance.destroy();if(platformChartInstance)platformChartInstance.destroy();if(paymentChartInstance)paymentChartInstance.destroy();const d={};if(s&&e){let c=new Date(s);while(c<=e){d[c.toISOString().split('T')[0]]=0;c.setDate(c.getDate()+1)}}
o.forEach(r=>{if(r.status!=='Cancelled'){const i=new Date(r.date).toISOString().split('T')[0];if(d[i]!==undefined)d[i]+=r.total}});revenueChartInstance=new Chart(revenueChartCanvas,{type:'line',data:{labels:Object.keys(d).map(l=>new Date(l).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'})),datasets:[{label:'Revenue',data:Object.values(d),borderColor:'#4f46e5',backgroundColor:'rgba(79, 70, 229, 0.1)',fill:true,tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:false}},scales:{x:{grid:{display:false}},y:{grid:{color:'#f1f5f9'}}}}});const p={Shopify:0,Amazon:0};o.forEach(r=>{if(r.status!=='Cancelled'&&p[r.platform]!==undefined)p[r.platform]+=r.total});platformChartInstance=new Chart(platformChartCanvas,{type:'doughnut',data:{labels:Object.keys(p),datasets:[{data:Object.values(p),backgroundColor:['#10b981','#f59e0b']}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:false}}}});const m={Prepaid:0,COD:0};o.forEach(r=>{if(r.paymentMethod){const i=r.paymentMethod.toLowerCase();if(i.includes("cod")||i.includes("cash")){m.COD++}else{m.Prepaid++}}});
paymentChartInstance=new Chart(paymentChartCanvas,{type:'doughnut',data:{labels:Object.keys(m),datasets:[{data:Object.values(m),backgroundColor:['#6366f1','#f43f5e']}]},options:{responsive:true,maintainAspectRatio:false,plugins:{title:{display:false},tooltip:{callbacks:{label:c=>{const t=c.chart.data.datasets[0].data.reduce((a,b)=>a+b,0);const p=t>0?((c.raw/t)*100).toFixed(1)+'%':'0%';return`${c.label}: ${c.raw} (${p})`}}}}}})}
function renderSettings(){const c=document.getElementById('seller-connections');c.innerHTML=connections.map(e=>`<div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between"><div class="flex items-center"><img src="${platformLogos[e.name]}" class="w-10 h-10 mr-4 rounded-lg bg-slate-50 p-1"><div><p class="font-bold text-slate-900">${e.name}</p><p class="text-sm text-slate-500">${e.status==='Connected'?e.user:'Click to connect'}</p></div></div><button data-platform="${e.name}" data-action="${e.status==='Connected'?'disconnect':'connect'}" class="connection-btn ${e.status==='Connected'?'text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100':'text-white bg-indigo-600 hover:bg-indigo-700'} px-4 py-2 rounded-lg text-sm font-medium transition-colors">${e.status==='Connected'?'Disconnect':'Connect'}</button></div>`).join('');document.querySelectorAll('.connection-btn').forEach(b=>b.addEventListener('click',e=>handleConnection(e.currentTarget.dataset.platform,e.currentTarget.dataset.action)))}
function handleConnection(p,a){if(a==='connect'){showNotification(`Simulating connection to ${p}...`);setTimeout(()=>{showNotification(`Successfully connected to ${p}.`)},1500)}else if(a==='disconnect'){if(confirm(`Are you sure you want to disconnect from ${p}?`)){showNotification(`Disconnected from ${p}.`)}}}
async function loadInitialData(){try{allOrders=await fetchOrdersFromServer();initializeAllFilters();navigate('orders-dashboard');setInterval(async()=>{if(['orders-dashboard','order-insights'].includes(currentView)){try{allOrders=await fetchOrdersFromServer();if(currentView==='orders-dashboard')renderAllDashboard();else renderAllInsights()}catch(e){console.error("Periodic refresh failed.")}}},120000)}catch(error){}}
function initializeAllFilters(){statusFilterEl.innerHTML=['All Statuses','New','Processing','Shipped','Cancelled'].map(s=>`<option value="${s==='All Statuses'?'All':s}">${s}</option>`).join('');statusFilterEl.value=activeStatusFilter;statusFilterEl.addEventListener('change',e=>{activeStatusFilter=e.target.value;renderAllDashboard()});const d={'today':'Today','yesterday':'Yesterday','last_7_days':'Last 7 Days','mtd':'Month to Date','last_month':'Last Month','custom':'Custom Range...'};
initializeDateFilters(insightsDatePresetFilter,insightsCustomDateContainer,insightsStartDateFilterEl,insightsEndDateFilterEl,'insightsDatePreset',renderAllInsights,d);
initializeDateFilters(adsetDatePresetFilter,adsetCustomDateContainer,adsetStartDateFilterEl,adsetEndDateFilterEl,'adsetDatePreset',()=>handleAdsetDateChange(false),d);
initializeDateFilters(orderDatePresetFilter,customDateContainer,startDateFilterEl,endDateFilterEl,'activeDatePreset',renderAllDashboard,d);
initializeDateFilters(profitDatePresetFilter, profitCustomDateContainer, profitStartDateFilterEl, profitEndDateFilterEl, 'profitDatePreset', handleProfitabilityChange, d);
initializeDateFilters(rankingDatePresetFilter, null, null, null, 'adsetDatePreset', () => handleAdsetDateChange(true), d);
initializeDateFilters(returnsDatePresetFilter, returnsCustomDateContainer, returnsStartDateFilterEl, returnsEndDateFilterEl, 'returnsDatePreset', renderReturnsAnalysis, d);
renderInsightsPlatformFilters()}
function initializeDateFilters(d,c,s,e,p,h,t){d.innerHTML=Object.entries(t).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
if(p==='insightsDatePreset')d.value=insightsDatePreset;else if(p==='adPerformanceDatePreset')d.value=adPerformanceDatePreset;else if(p==='adsetDatePreset')d.value=adsetDatePreset;else if(p==='activeDatePreset')d.value=activeDatePreset;else if(p==='profitDatePreset')d.value=profitDatePreset;else if(p==='returnsDatePreset')d.value=returnsDatePreset;
const dateChange=()=>{const v=d.value;if(p==='insightsDatePreset')insightsDatePreset=v;else if(p==='adPerformanceDatePreset')adPerformanceDatePreset=v;else if(p==='adsetDatePreset')adsetDatePreset=v;else if(p==='activeDatePreset')activeDatePreset=v;else if(p==='profitDatePreset')profitDatePreset=v;else if(p==='returnsDatePreset')returnsDatePreset=v;if(c) c.classList.toggle('hidden',v!=='custom');h()};d.addEventListener('change',dateChange);if(s) s.addEventListener('change',h);if(e) e.addEventListener('change',h)}
async function handlePdfDownload(){const[s,e]=calculateDateRange(adsetDatePreset,adsetStartDateFilterEl.value,adsetEndDateFilterEl.value);if(!adsetPerformanceData||adsetPerformanceData.length===0){showNotification("No data available to download.",true);return}
if(!s||!e){showNotification("Please select a valid date range.",true);return}
const since=s.toISOString().split('T')[0];const until=e.toISOString().split('T')[0];showNotification("Generating PDF report...");try{const blob=await fetchApiData(`/download-dashboard-pdf?since=${since}&until=${until}`,"Failed to generate PDF",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(adsetPerformanceData)});const url=window.URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`adset_report_${since}_to_${until}.pdf`;document.body.appendChild(a);a.click();a.remove();window.URL.revokeObjectURL(url);showNotification("PDF download started successfully!")}catch(err){}}

async function handleExcelDownload() {
    const [startDate, endDate] = calculateDateRange(adsetDatePreset, adsetStartDateFilterEl.value, adsetEndDateFilterEl.value);
    if (!startDate || !endDate) {
        showNotification("Please select a valid date range.", true);
        return;
    }
    const since = startDate.toISOString().split('T')[0];
    const until = endDate.toISOString().split('T')[0];
    showNotification("Generating detailed Excel report...");
    const dateFilterType = adsetDateFilterTypeEl ? adsetDateFilterTypeEl.value : 'order_date';
    const excelEndpoint = `/download-excel-report?since=${since}&until=${until}&date_filter_type=${dateFilterType}`;
    try {
        const blob = await fetchApiData(excelEndpoint, "Failed to generate Excel report");
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `detailed_report_${since}_to_${until}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
    } catch(e) { }
}

document.getElementById('nav-reports')?.addEventListener('click', (e) => { e.preventDefault(); navigate('reports-view'); });

document.getElementById('btn-download-amazon-report')?.addEventListener('click', async () => {
    const startDate = document.getElementById('amazon-report-start-date').value;
    const endDate = document.getElementById('amazon-report-end-date').value;
    if (!startDate || !endDate) {
        showNotification('Please select both start and end dates', true);
        return;
    }
    showNotification('Generating Amazon report...');
    try {
        const blob = await fetchApiData(`/download-amazon-sales-report?start_date=${startDate}&end_date=${endDate}`, 'Failed to generate Amazon report');
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `amazon_mtr_report_${startDate}_to_${endDate}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        showNotification('Amazon report downloaded successfully!');
    } catch (error) { }
});

document.addEventListener('DOMContentLoaded', () => {
    loginView = document.getElementById('login-view');
    appView = document.getElementById('app');
    logoutBtn = document.getElementById('logout-btn');
    loginBtn = document.getElementById('login-btn');
    loginEmailEl = document.getElementById('login-email');
    loginPasswordEl = document.getElementById('login-password');
    notificationEl = document.getElementById('notification');
    notificationMessageEl = document.getElementById('notification-message');
    globalLoader = document.getElementById('global-loader'); 

    navOrdersDashboard = document.getElementById('nav-orders-dashboard');
    navOrderInsights = document.getElementById('nav-order-insights');
    navAdRanking = document.getElementById('nav-ad-ranking');
    navAdsetBreakdown = document.getElementById('nav-adset-breakdown');
    navAdAnalysis = document.getElementById('nav-ad-analysis'); 
    navSettings = document.getElementById('nav-settings');
    navProfitability = document.getElementById('nav-profitability');
    navCustomerSegments = document.getElementById('nav-customer-segments');
    navReturnsAnalysis = document.getElementById('nav-returns-analysis');

    ordersDashboardView = document.getElementById('orders-dashboard-view');
    orderInsightsView = document.getElementById('order-insights-view');
    adRankingView = document.getElementById('ad-ranking-view');
    adsetBreakdownView = document.getElementById('adset-breakdown-view');
    adAnalysisView = document.getElementById('ad-analysis-view'); 
    settingsView = document.getElementById('settings-view');
    profitabilityView = document.getElementById('profitability-view');
    customerSegmentsView = document.getElementById('customer-segments-view');
    returnsAnalysisView = document.getElementById('returns-analysis-view');

    ordersListEl = document.getElementById('orders-list');
    statusFilterEl = document.getElementById('status-filter');
    orderDatePresetFilter = document.getElementById('order-date-preset-filter');
    customDateContainer = document.getElementById('custom-date-container');
    startDateFilterEl = document.getElementById('start-date-filter');
    endDateFilterEl = document.getElementById('end-date-filter');
    platformFiltersEl = document.getElementById('platform-filters');
    
    dashboardKpiElements = { newOrders: document.getElementById('kpi-dashboard-new'), processing: document.getElementById('kpi-dashboard-processing'), shipped: document.getElementById('kpi-dashboard-shipped'), cancelled: document.getElementById('kpi-dashboard-cancelled') };
    insightsKpiElements = { revenue: { el: document.getElementById('kpi-insights-revenue') }, avgValue: { el: document.getElementById('kpi-insights-avg-value') }, allOrders: { el: document.getElementById('kpi-insights-all-orders') }, new: { el: document.getElementById('kpi-insights-new') }, shipped: { el: document.getElementById('kpi-insights-shipped') }, rto: { el: document.getElementById('kpi-insights-rto') }, cancelled: { el: document.getElementById('kpi-insights-cancelled') }};
    
    revenueChartCanvas = document.getElementById('revenue-chart');
    platformChartCanvas = document.getElementById('platform-chart');
    paymentChartCanvas = document.getElementById('payment-chart');
    
    insightsDatePresetFilter = document.getElementById('insights-date-preset-filter');
    insightsCustomDateContainer = document.getElementById('insights-custom-date-container');
    insightsStartDateFilterEl = document.getElementById('insights-start-date-filter');
    insightsEndDateFilterEl = document.getElementById('insights-end-date-filter');
    insightsPlatformFiltersEl = document.getElementById('insights-platform-filters');
    
    adsetPerformanceTableBody = document.getElementById('adset-performance-table-body');
    
    adsetDatePresetFilter = document.getElementById('adset-date-preset-filter');
    adsetCustomDateContainer = document.getElementById('adset-custom-date-container');
    adsetStartDateFilterEl = document.getElementById('adset-start-date-filter');
    adsetEndDateFilterEl = document.getElementById('adset-end-date-filter');
    
    profitDatePresetFilter = document.getElementById('profit-date-preset-filter');
    profitCustomDateContainer = document.getElementById('profit-custom-date-container');
    profitStartDateFilterEl = document.getElementById('profit-start-date-filter');
    profitEndDateFilterEl = document.getElementById('profit-end-date-filter');
    profitTrendChartCanvas = document.getElementById('profit-trend-chart');

    rankingDatePresetFilter = document.getElementById('ranking-date-preset-filter');
    adRankingChartCanvas = document.getElementById('ad-ranking-chart');
    adRankingListEl = document.getElementById('ad-ranking-list');

    customerSegmentChartCanvas = document.getElementById('customer-segment-chart');
    vipCustomerListEl = document.getElementById('vip-customer-list');
    customerLimitFilter = document.getElementById('customer-limit-filter'); 

    rtoProductChartCanvas = document.getElementById('rto-product-chart');
    rtoCityListEl = document.getElementById('rto-city-list');
    returnsDatePresetFilter = document.getElementById('returns-date-preset-filter'); 
    returnsCustomDateContainer = document.getElementById('returns-custom-date-container'); 
    returnsStartDateFilterEl = document.getElementById('returns-start-date-filter'); 
    returnsEndDateFilterEl = document.getElementById('returns-end-date-filter'); 
    
    adAnalysisTableBody = document.getElementById('ad-analysis-table-body'); 
    adAnalysisPaymentFilter = document.getElementById('ad-analysis-payment-filter'); 

    downloadPdfBtn = document.getElementById('download-adset-pdf');
    downloadExcelBtn = document.getElementById('download-adset-excel');
    adsetDateFilterTypeEl = document.getElementById('adset-date-filter-type');

    loginBtn?.addEventListener('click', handleLogin);
    loginEmailEl?.addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    loginPasswordEl?.addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    logoutBtn?.addEventListener('click', logout);
    
    navOrdersDashboard?.addEventListener('click', (e) => { e.preventDefault(); navigate('orders-dashboard'); });
    navOrderInsights?.addEventListener('click', (e) => { e.preventDefault(); navigate('order-insights'); });
    navAdRanking?.addEventListener('click', (e) => { e.preventDefault(); navigate('ad-ranking'); });
    navAdsetBreakdown?.addEventListener('click', (e) => { e.preventDefault(); navigate('adset-breakdown'); });
    navAdAnalysis?.addEventListener('click', (e) => { e.preventDefault(); navigate('ad-analysis'); });
    navSettings?.addEventListener('click', (e) => { e.preventDefault(); navigate('settings'); });
    navProfitability?.addEventListener('click', (e) => { e.preventDefault(); navigate('profitability'); });
    navCustomerSegments?.addEventListener('click', (e) => { e.preventDefault(); navigate('customer-segments'); });
    navReturnsAnalysis?.addEventListener('click', (e) => { e.preventDefault(); navigate('returns-analysis'); });
    
    downloadPdfBtn?.addEventListener('click', handlePdfDownload);
    downloadExcelBtn?.addEventListener('click', handleExcelDownload);
    adsetDateFilterTypeEl?.addEventListener('change', () => handleAdsetDateChange(currentView === 'ad-ranking'));
    
    adAnalysisPaymentFilter?.addEventListener('change', renderAdAnalysis);
    customerLimitFilter?.addEventListener('change', () => renderCustomerSegments(currentSortKey || 'spent', currentSortOrder || 'desc'));

    document.querySelectorAll("#adsetPerformanceTable th.sortable").forEach(th => {
        th.dataset.originalText = th.textContent.replace(/[▲▼⬍]/g, "").trim();
        th.onclick = () => {
            const key = th.dataset.key;
            if (!key) return;
            if (currentSortKey === key) {
                currentSortOrder = currentSortOrder === "asc" ? "desc" : "asc";
            } else {
                currentSortKey = key;
                currentSortOrder = "asc";
            }
            document.querySelectorAll("#adsetPerformanceTable th.sortable").forEach(h => {
                h.textContent = `${h.dataset.originalText} ⬍`;
            });
            th.textContent = `${th.dataset.originalText} ${currentSortOrder === "asc" ? "▲" : "▼"}`;
            renderAdsetPerformanceDashboard();
        };
    });

    document.querySelectorAll('.nav-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const targetId = header.dataset.target;
            const targetContent = document.getElementById(targetId);
            const arrow = header.querySelector('.arrow-icon');
            
            if (targetContent.classList.contains('expanded')) {
                targetContent.classList.remove('expanded');
                targetContent.classList.add('collapsed');
                arrow.classList.remove('rotate-180');
            } else {
                document.querySelectorAll('.nav-content').forEach(content => {
                    content.classList.remove('expanded');
                    content.classList.add('collapsed');
                });
                document.querySelectorAll('.arrow-icon').forEach(icon => {
                    icon.classList.remove('rotate-180');
                });
                
                targetContent.classList.remove('collapsed');
                targetContent.classList.add('expanded');
                arrow.classList.add('rotate-180');
            }
        });
    });

    const savedToken = localStorage.getItem('authToken');
    if (savedToken) {
        authToken = savedToken;
        showApp();
    } else {
        showLogin();
        prefillLoginDetails();
    }
});