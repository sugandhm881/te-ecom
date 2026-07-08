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
let activeDatePreset = 'last_7_days';
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
let customerDatePreset = 'last_30_days';   // Default for Customers
let adAnalysisDatePreset = 'last_7_days';  // Default for Ad Analysis
let codConfirmations = [];
let currentSearchTerm = '';
let activeCodFilter = 'All';

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
// New Date Filters
let customerDatePresetFilter, customerCustomDateContainer, customerStartDateFilterEl, customerEndDateFilterEl;
let adAnalysisDatePresetFilter, adAnalysisCustomDateContainer, adAnalysisStartDateFilterEl, adAnalysisEndDateFilterEl;

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

// Count-based loader — multiple concurrent callers handled gracefully
let _loaderCount = 0, _loaderHideTimer = null;
function showLoader() {
  _loaderCount++;
  clearTimeout(_loaderHideTimer);
  if (globalLoader) {
    globalLoader.classList.add('active');
    requestAnimationFrame(() => globalLoader.classList.add('visible'));
  }
}
function hideLoader(force) {
  if (force) _loaderCount = 0; else _loaderCount = Math.max(0, _loaderCount - 1);
  if (_loaderCount === 0) {
    _loaderHideTimer = setTimeout(() => {
      if (_loaderCount > 0 || !globalLoader) return;
      globalLoader.classList.remove('visible');
      setTimeout(() => { if (_loaderCount === 0) globalLoader.classList.remove('active'); }, 200);
    }, 260);
  }
}

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
        case 'Processing': return 'bg-purple-50 text-purple-700 border border-purple-200';
        // FIXED: Darker Orange for better visibility
        case 'Ready To Ship': return 'bg-orange-100 text-orange-800 border border-orange-200';
        
        case 'Shipped': return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
        case 'In Transit': return 'bg-cyan-50 text-cyan-700 border border-cyan-200';
        case 'Out For Delivery': return 'bg-teal-50 text-teal-700 border border-teal-200';
        
        case 'Delivered': return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
        case 'Cancelled': return 'bg-slate-100 text-slate-500 border border-slate-200';
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
    showLoader();
    const headers = { ...getAuthHeaders(), ...options.headers };
    if (!headers.Authorization) { hideLoader(); logout(); return Promise.reject("Unauthorized"); }

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
    } finally {
        hideLoader();
    }
}

// Shopify order data enriched with EasyEcom order IDs for confirm/approve.
const fetchOrdersFromServer = () => fetchApiData(`/get-orders`, 'Failed to fetch orders.');

// --- Silent background refresh (auto every 1 min) ---
async function silentRefreshOrders() {
    if (!['orders-dashboard', 'order-insights'].includes(currentView)) return;
    try {
        await Promise.all([
            fetchOrdersFromServer().then(data => { allOrders = data; }),
            fetchCodConfirmations()
        ]);
        if (currentView === 'orders-dashboard') renderAllDashboard();
        else renderAllInsights();
        updateLastSyncedLabel();
    } catch (e) {
        console.error('Auto-refresh failed:', e);
    }
}

// --- Manual refresh (button click) ---
async function manualRefreshOrders() {
    const btn   = document.getElementById('refresh-orders-btn');
    const icon  = document.getElementById('refresh-icon');
    const label = document.getElementById('refresh-btn-label');
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('animate-spin');
    if (label) label.textContent = 'Syncing...';
    try {
        // Sync EasyEcom orders first, then fetch all orders
        await fetchApiData('/easyecom/get-orders?days=7', 'EasyEcom sync failed').catch(() => {});
        await Promise.all([
            fetchOrdersFromServer().then(data => { allOrders = data; }),
            fetchCodConfirmations()
        ]);
        if (currentView === 'orders-dashboard') renderAllDashboard();
        else renderAllInsights();
        updateLastSyncedLabel();
        showNotification('Orders refreshed.');
    } catch (e) {
        showNotification('Refresh failed.', true);
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('animate-spin');
        if (label) label.textContent = 'Refresh';
    }
}

function updateLastSyncedLabel() {
    const wrap = document.getElementById('last-synced-label');
    const time = document.getElementById('last-synced-time');
    if (!wrap || !time) return;
    const now = new Date();
    time.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    wrap.classList.remove('hidden');
}
const fetchAdPerformanceData = (since, until) => fetchApiData(`/get-ad-performance?since=${since}&until=${until}`, 'Failed to fetch ad performance.');
const fetchAdsetPerformanceData = (endpoint) => fetchApiData(endpoint, 'Failed to fetch ad set performance.');

// --- ACTIONS (Client-side Download) ---
async function downloadShipmentLabel(awb) {
    if (!awb) { showNotification("No AWB number found.", true); return; }
    const btn = document.activeElement;
    const originalText = btn ? btn.textContent : 'Label';
    if(btn) btn.textContent = "Opening...";
    showLoader();
    try {
        const response = await fetch(`/api/get-shipping-label?awb=${awb}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await response.json();
        if (response.ok && data.success && data.url) {
            window.open(data.url, '_blank');
            showNotification("Label opened in new tab.");
        } else { throw new Error(data.error || "Label URL not found"); }
    } catch (err) { showNotification("Failed: " + err.message, true); } finally { if(btn) btn.textContent = originalText; hideLoader(); }
}

// --- UI RENDERING ---
function navigate(view) {
    showLoader();
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
        case 'amazon-review':
            activeLinkElement = document.getElementById('nav-amazon-review');
            activeViewElement = document.getElementById('amazon-review-view');
            if (!amzReviewLoaded) { amzReviewLoaded = true; amzRevLoadOrders(); }
            break;
        case 'fulfillment-ops':
            activeLinkElement = document.getElementById('nav-fulfillment-ops');
            activeViewElement = document.getElementById('fulfillment-ops-view');
            fopsInit();
            break;
        case 'serviceability':
            activeLinkElement = document.getElementById('nav-serviceability');
            activeViewElement = document.getElementById('serviceability-view');
            if (typeof srvInit === 'function') srvInit();
            break;
        case 'delivery-perf':
            activeLinkElement = document.getElementById('nav-delivery-perf');
            activeViewElement = document.getElementById('delivery-perf-view');
            if (typeof dpInit === 'function') dpInit();
            break;
        case 'ops-control':
            activeLinkElement = document.getElementById('nav-ops-control');
            activeViewElement = document.getElementById('ops-control-view');
            if (typeof opsInit === 'function') opsInit();
            break;
        case 'docpharma-recon':
            activeLinkElement = document.getElementById('nav-docpharma-recon');
            activeViewElement = document.getElementById('docpharma-recon-view');
            if (typeof dpreInit === 'function') dpreInit();
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
    hideLoader(); // balance the showLoader() at the top; async fetches re-show independently
}

// checkAndUpdateWorkflow removed — EasyEcom handles order processing now

// --- DASHBOARD FILTERS RENDERING (Added COD Filter) ---
function renderDashboardFilters() {
    // 1. Platform Buttons
    platformFiltersEl.innerHTML = ['All', 'Shopify', 'Amazon'].map(p =>
        `<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${activePlatformFilter===p ? 'active' : ''}">${p}</button>`
    ).join('');
    
    // 2. Source Buttons (RapidShyp/DocPharma)
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

    // 3. NEW: COD Status Filter Dropdown
    let codFilterContainer = document.getElementById('cod-filter-container');
    if (!codFilterContainer) {
        codFilterContainer = document.createElement('div');
        codFilterContainer.id = 'cod-filter-container';
        codFilterContainer.className = 'ml-4 relative';
        // Insert it right after the Status Filter (status-filter is usually before date preset)
        const statusEl = document.getElementById('status-filter');
        if(statusEl && statusEl.parentNode) {
            statusEl.parentNode.insertBefore(codFilterContainer, statusEl.nextSibling);
        }
    }

    codFilterContainer.innerHTML = `
        <select id="cod-filter-select" class="filter-select pl-3 pr-8 py-1.5 text-sm font-medium text-slate-600 focus:outline-none cursor-pointer bg-white border border-slate-200 rounded-full shadow-sm hover:border-indigo-300 transition-colors">
            <option value="All">All COD Status</option>
            <option value="Confirmed">✓ Confirmed</option>
            <option value="Waiting">Waiting...</option>
            <option value="Cancelled">Cancelled</option>
            <option value="No Data">No Data</option>
        </select>
    `;

    // 4. Attach Listeners
    platformFiltersEl.querySelectorAll('.filter-btn').forEach(b => {
        b.addEventListener('click', () => { activePlatformFilter = b.dataset.filter; renderAllDashboard(); });
    });
    
    sourceContainer.querySelectorAll('.source-btn').forEach(b => {
        b.addEventListener('click', () => { activeSourceFilter = b.dataset.source; renderAllDashboard(); });
    });

    const codSelect = document.getElementById('cod-filter-select');
    if(codSelect) {
        codSelect.value = activeCodFilter;
        codSelect.addEventListener('change', (e) => {
            activeCodFilter = e.target.value;
            renderAllDashboard();
        });
    }
}

// --- UPDATED RENDER DASHBOARD (With COD Filter Logic) ---
function renderAllDashboard() {
    const [s, e] = calculateDateRange(activeDatePreset, startDateFilterEl.value, endDateFilterEl.value);
    let o = [...allOrders];

    // Helper to extract numeric ID for matching
    const extractNum = (str) => {
        if (!str) return '';
        const s = String(str);
        const match = s.match(/(\d+)$/); 
        return match ? match[0] : s.replace(/\D/g, ''); 
    };

    // 1. Date Filter
    if (s && e) {
        o = o.filter(t => { 
            const parts = t.date.split('-'); 
            const d = new Date(parts[2], parts[1] - 1, parts[0]); 
            return d >= s && d <= e; 
        });
    }

    // 2. Platform Filter
    if (activePlatformFilter !== 'All') {
        o = o.filter(t => t.platform === activePlatformFilter);
    }

    // 3. Status Filter (UPDATED)
    if (activeStatusFilter !== 'All') {
        if (activeStatusFilter === 'In Transit') {
            o = o.filter(t => {
                // Must be one of the moving statuses
                const isForwardMoving = ['Shipped', 'In Transit', 'Out For Delivery'].includes(t.status);
                
                // Check if it is actually RTO (by Tag or Status Text)
                const isRto = t.status.toUpperCase().includes('RTO') || 
                              (t.tags && t.tags.toLowerCase().includes('rto'));

                // Show only if moving forward AND NOT RTO
                return isForwardMoving && !isRto;
            });
        } else {
            o = o.filter(t => t.status === activeStatusFilter);
        }
    }

    // 4. Source Filter
    if (activeSourceFilter !== 'All') {
        o = o.filter(order => {
            const tags = (order.tags || '').toLowerCase();
            const isDocPharma = tags.includes('docpharma: in-progress');
            if (activeSourceFilter === 'DocPharma') return isDocPharma;
            if (activeSourceFilter === 'RapidShyp') return !isDocPharma;
            return true;
        });
    }

    // 5. [NEW] COD Status Filter
    if (activeCodFilter !== 'All') {
        o = o.filter(order => {
            const dashNum = extractNum(order.id);
            const codData = codConfirmations?.find(c => {
                const sheetNum1 = extractNum(c['Order Number']);
                const sheetNum2 = extractNum(c['Order Name']);
                return (sheetNum1 === dashNum) || (sheetNum2 === dashNum);
            });

            if (!codData) return activeCodFilter === 'No Data';

            const rawResponse = String(codData['Confirmation received'] || '').toUpperCase().trim();
            const status = String(codData['status'] || '').toLowerCase().trim();

            if (activeCodFilter === 'Confirmed') {
                return ['CONFIRM', 'YES', 'CONFIRMED', 'OK'].includes(rawResponse);
            }
            if (activeCodFilter === 'Cancelled') {
                return ['CANCEL', 'NO', 'REJECT'].includes(rawResponse);
            }
            if (activeCodFilter === 'Waiting') {
                // It is waiting if it's NOT confirmed AND NOT cancelled, but exists
                const isConfirmed = ['CONFIRM', 'YES', 'CONFIRMED', 'OK'].includes(rawResponse);
                const isCancelled = ['CANCEL', 'NO', 'REJECT'].includes(rawResponse);
                return !isConfirmed && !isCancelled;
            }
            return false;
        });
    }

    // 6. Search Filter
    if (currentSearchTerm) {
        o = o.filter(item => 
            (item.id && item.id.toLowerCase().includes(currentSearchTerm)) ||
            (item.name && item.name.toLowerCase().includes(currentSearchTerm)) ||
            (item.email && item.email.toLowerCase().includes(currentSearchTerm)) ||
            (item.phone && String(item.phone).includes(currentSearchTerm)) ||
            (item.shipping_address && item.shipping_address.phone && String(item.shipping_address.phone).includes(currentSearchTerm)) ||
            (item.awb && String(item.awb).toLowerCase().includes(currentSearchTerm)) ||
            (item.total && String(item.total).includes(currentSearchTerm))
        );
    }

    const t = [...o].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    renderDashboardFilters(); 
    renderSearchInput(); 
    
    renderOrders(t);
    updateDashboardKpis(o);
}

// --- FIXED SEARCH INPUT (Responsive Width) ---
function renderSearchInput() {
    // Prevent duplicate creation
    if (document.getElementById('search-container-custom')) return;

    const searchContainer = document.createElement('div');
    searchContainer.id = 'search-container-custom';
    // Changed: Reduced left margin (ml-2) and added right margin (mr-2)
    // Added 'flex-shrink-0' so it doesn't get squashed weirdly
    searchContainer.className = 'relative ml-2 md:ml-4 mr-2 flex items-center flex-shrink-0'; 
    
    // Search Icon & Input HTML
    searchContainer.innerHTML = `
        <div class="relative group">
            <span class="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 group-focus-within:text-indigo-500 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </span>
            <input type="text" id="global-order-search" 
                placeholder="Search..." 
                class="pl-10 pr-4 py-1.5 text-sm border border-slate-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 shadow-sm transition-all duration-300 w-32 md:w-48 lg:w-64 focus:w-64"
                autocomplete="off">
        </div>
    `;

    // Append next to other filters (Ensure platformFiltersEl exists)
    if (platformFiltersEl && platformFiltersEl.parentNode) {
        // Ensure the parent container allows wrapping if screen is too small
        platformFiltersEl.parentNode.classList.add('flex-wrap'); 
        platformFiltersEl.parentNode.appendChild(searchContainer);
    }

    // Add Event Listener
    const inputEl = document.getElementById('global-order-search');
    if (inputEl) {
        // Restore focus/value if re-rendering
        if (typeof currentSearchTerm !== 'undefined') inputEl.value = currentSearchTerm;
        
        inputEl.addEventListener('input', (e) => {
            currentSearchTerm = e.target.value.toLowerCase().trim();
            renderAllDashboard(); // Re-render table on type
            
            // Keep focus after re-render (trick)
            setTimeout(() => {
                const newInput = document.getElementById('global-order-search');
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(newInput.value.length, newInput.value.length);
                }
            }, 0);
        });
    }
}

// --- ORDER LIST RENDERING (Trusts Shopify Tags + Local History) ---
function renderOrders(o) {
    ordersListEl.innerHTML = '';
    updateBulkActionBar(); 

    if (o.length === 0) {
        ordersListEl.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-slate-400">No orders found.</td></tr>`;
        return;
    }

    // Helper: Extract Number from ID
    const extractNum = (str) => {
        if (!str) return '';
        const s = String(str);
        const match = s.match(/(\d+)$/); 
        return match ? match[0] : s.replace(/\D/g, ''); 
    };

    // Helper: Normalize Phone (Last 10 digits only)
    const cleanPhone = (p) => {
        if (!p) return '';
        return String(p).replace(/\D/g, '').slice(-10);
    };

    o.forEach(order => {
        const displayName = (order.name === 'N/A' && order.buyerName) ? order.buyerName : order.name;
        const uniqueId = order.id.replace(/\W/g, ''); 
        const isSelected = selectedOrders.has(order.originalId);
        
        const custBadge = getCustomerBadge(order.email, null, order.id);

        const mainRow = document.createElement('tr');
        mainRow.className = `order-row border-b border-slate-100 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-indigo-50/50' : ''}`;
        mainRow.dataset.orderId = order.id;

        // =========================================================================
        // 1. GATHER DATA (Shopify Tags & Local History)
        // =========================================================================
        
        // A. Get Shopify Tags (Lowercase for easy checking)
        const shopifyTags = (order.tags || '').toLowerCase();
        
        // B. Calculate History (Strict Phone/Email Match)
        const currentPhone = cleanPhone(order.phone);
        const currentEmail = order.email ? order.email.toLowerCase().trim() : '';

        const history = allOrders.filter(x => {
            const xPhone = cleanPhone(x.phone);
            const phoneMatch = currentPhone && xPhone && (currentPhone === xPhone);
            const xEmail = x.email ? x.email.toLowerCase().trim() : '';
            const emailMatch = currentEmail && xEmail && (currentEmail === xEmail);
            return phoneMatch || emailMatch;
        });

        // =========================================================================
        // 2. DETERMINE STATUS FLAGS
        // =========================================================================
        
        // IS REPEAT? -> (Shopify says 'repeat') OR (We found > 1 order)
        const isRepeat = shopifyTags.includes('repeat') || history.length > 1;

        // IS DELIVERED CUSTOMER? -> (Shopify says 'delivered') OR (History has 'Delivered' status)
        const isDeliveredCustomer = shopifyTags.includes('delivered') || history.some(h => {
             const s = String(h.status).toLowerCase();
             // Check if any PAST order was delivered
             return (s === 'delivered' || s === 'completed') && String(h.id) !== String(order.id);
        });

        // =========================================================================
        // 3. GENERATE BADGE HTML
        // =========================================================================
        let tagsHtml = '';

        if (isRepeat) {
            tagsHtml += `<span class="inline-block px-1.5 py-0.5 text-[10px] font-bold text-indigo-600 bg-indigo-50 rounded border border-indigo-100 uppercase tracking-wide mr-1 mb-1">Repeat</span>`;
        } else {
            tagsHtml += `<span class="inline-block px-1.5 py-0.5 text-[10px] font-bold text-slate-500 bg-slate-100 rounded border border-slate-200 uppercase tracking-wide mr-1 mb-1">New</span>`;
        }

        // Show Delivered Badge (Independent check - fixes the missing badge issue)
        if (isDeliveredCustomer) {
            tagsHtml += `<span class="inline-block px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 rounded border border-emerald-100 uppercase tracking-wide mr-1 mb-1">Delivered</span>`;
        }

        // VIP Check
        if (history.length > 5 || parseFloat(order.total) > 5000 || shopifyTags.includes('vip')) {
             tagsHtml += `<span class="inline-block px-1.5 py-0.5 text-[10px] font-bold text-amber-600 bg-amber-50 rounded border border-amber-100 uppercase tracking-wide mr-1 mb-1">VIP</span>`;
        }

        // --- PREPARE DISPLAY DATA ---
        const tagsDisplay = (order.tags || 'None');
        const hoverText = tagsDisplay !== 'None' ? `Tags: ${tagsDisplay}` : '';

        // --- COD LOGIC ---
        let codBadge = '<span class="text-[10px] text-slate-300">-</span>'; 
        const dashNum = extractNum(order.id);
        let rawPhone = order.phone || (order.shipping_address ? order.shipping_address.phone : '') || '';
        let displayPhone = String(rawPhone).replace(/^(\+91|91)/, ''); 

        const codData = codConfirmations?.find(c => {
            const sheetNum1 = extractNum(c['Order Number']);
            const sheetNum2 = extractNum(c['Order Name']);
            return (sheetNum1 === dashNum) || (sheetNum2 === dashNum);
        });

        if (codData) {
            // Try multiple possible column names for confirmation field (match sheet header exactly)
            const confirmVal = codData['Confirmation received'] || codData['Confirmation Received']
                || codData['COD Confirmation'] || codData['Confirmation'] || codData['Response']
                || codData['COD Status'] || codData['Status'] || '';
            const rawResponse = String(confirmVal).toUpperCase().trim();

            if (['CONFIRM', 'YES', 'CONFIRMED', 'OK', 'Y'].includes(rawResponse)) {
                codBadge = `<span class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-emerald-700 bg-emerald-100 rounded border border-emerald-200 uppercase tracking-wide">✓ Confirmed</span>`;
            } else if (['CANCEL', 'NO', 'REJECT', 'REJECTED', 'N'].includes(rawResponse)) {
                codBadge = `<span class="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-rose-700 bg-rose-100 rounded border border-rose-200 uppercase tracking-wide">Cancelled</span>`;
            } else {
                // Order found in sheet but confirmation pending / unknown value
                codBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-amber-600 bg-amber-50 rounded border border-amber-200">Waiting...</span>`;
            }
        }

        // --- ADDRESS ---
        let detailedAddress = order.address || 'No address provided';
        if (order.shipping_address && typeof order.shipping_address === 'object') {
            const { address1, address2, city, province, zip } = order.shipping_address;
            detailedAddress = [address1, address2, city, province, zip ? `(${zip})` : ''].filter(Boolean).join(', ');
        }

        // --- EDD (estimated delivery) ---
        // Only meaningful for orders awaiting dispatch; shipped/closed orders show "—".
        const eddPin = getOrderPincode(order);
        const eddApplies = EDD_PENDING_STATUSES.has(order.status) && /^\d{6}$/.test(eddPin || '');
        const eddCell = eddApplies
            ? `<span class="edd-cell text-xs text-slate-400" data-pin="${eddPin}" data-wt="0.5" title="Estimated delivery if dispatched today">…</span>`
            : `<span class="text-[11px] text-slate-300">—</span>`;

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
                <div class="flex flex-col">
                    <div class="flex items-center">
                        ${displayName}
                        ${custBadge}
                    </div>
                    <div class="text-[11px] text-slate-500 mt-1 flex items-center gap-2">
                        <span class="font-semibold text-slate-600 uppercase text-[10px] tracking-wide">${order.paymentMethod || 'Unknown'}</span>
                        <span class="text-slate-300">|</span>
                        <span class="font-mono text-slate-600 flex items-center gap-1">
                            <svg class="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
                            ${displayPhone}
                        </span>
                    </div>
                </div>
            </td>
            <td class="p-4">
                <div class="flex flex-wrap w-24">
                    ${tagsHtml}
                </div>
            </td>
            <td class="p-4">
                ${codBadge}
            </td>
            <td class="p-4 font-medium text-slate-900">${formatCurrency(order.total)}</td>
            <td class="p-4"><span class="px-3 py-1 text-xs font-semibold rounded-full whitespace-nowrap ${getStatusBadge(order.status)}">${order.status}</span></td>
            <td class="p-4 text-center">${eddCell}</td>
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

        let workflowHtml = '';
        const tags = (order.tags || '').toLowerCase();
        const hasInProgress = tags.includes('docpharma: in-progress');
        const shouldShow = (order.platform === 'Shopify') && (!hasInProgress);

        if (shouldShow) {
             const status = order.status;

             const isConfirmed = order.easyecomStatus && !['new', 'unconfirmed', 'open', ''].includes((order.easyecomStatus || '').toLowerCase());
             const hasEasyecomId = !!order.easyecomOrderId;

             if (status !== 'Cancelled') {
                workflowHtml = `
                    <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mt-2">
                        <div class="flex justify-between items-center mb-4">
                            <h4 class="text-xs font-bold text-slate-500 uppercase tracking-wide">EasyEcom Order Processing</h4>
                            <span class="px-2 py-1 rounded text-[10px] font-bold uppercase ${getStatusBadge(status)}">${status}</span>
                        </div>
                        <div class="space-y-3">
                            <div class="flex justify-between items-center">
                                <div>
                                    <p class="text-sm font-semibold text-slate-800">Confirm Order</p>
                                    <p class="text-[10px] text-slate-400 mt-0.5">${hasEasyecomId ? 'EasyEcom ID: ' + order.easyecomOrderId : 'EasyEcom ID not mapped yet'}</p>
                                    ${order.easyecomStatus ? `<p class="text-[10px] text-slate-500 mt-0.5">EasyEcom Status: <span class="font-semibold">${order.easyecomStatus}</span></p>` : ''}
                                </div>
                                ${ isConfirmed ?
                                    `<span class="px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded border border-emerald-200">Confirmed</span>` :
                                    hasEasyecomId ?
                                        `<button onclick="handleManualStep1('${order.originalId}', '${uniqueId}')" id="btn-step1-${uniqueId}" class="px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 shadow-sm">Approve</button>` :
                                        `<span class="px-3 py-1 bg-amber-50 text-amber-600 text-xs font-medium rounded border border-amber-200">Syncing...</span>`
                                }
                            </div>
                            ${order.awb ? `
                            <div class="flex justify-between items-center pt-2 border-t border-slate-100">
                                <div>
                                    <p class="text-sm font-semibold text-slate-800">Shipping</p>
                                    <p class="text-[10px] text-slate-400 font-mono">${order.courier || ''} ${order.awb}</p>
                                </div>
                                <span class="text-xs font-bold text-emerald-600">Assigned</span>
                            </div>` : ''}
                        </div>
                    </div>
                `;
             }
        }

        detailsRow.innerHTML = `
            <td colspan="11" class="p-0">
                <div class="p-6 grid grid-cols-1 md:grid-cols-2 gap-8 border-t border-slate-100">
                    <div class="space-y-4">
                        <div>
                            <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Customer Details</h4>
                            <div class="bg-white p-3 rounded border border-slate-200 text-sm">
                                <p class="font-bold text-slate-800">${displayName}</p>
                                <p class="text-slate-500 mt-1 leading-relaxed">${detailedAddress}</p>
                                <p class="text-slate-400 text-xs mt-1 border-t border-slate-100 pt-1">${order.email || ''}</p>
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

    eddEnrichVisible();
}

// ─── EDD (Estimated Delivery Date) column ──────────────────────────────────
// Statuses still awaiting dispatch — EDD ("if dispatched today") is relevant here.
const EDD_PENDING_STATUSES = new Set(['New', 'Processing', 'Ready To Ship', 'Confirmed']);
// Client-side cache: "<pin>-<wt>" -> summary (mirrors server cache, avoids refetch on re-render)
const eddClientCache = {};

// Pull a 6-digit delivery pincode off whatever address shape the order has.
function getOrderPincode(order) {
    const a = order.shipping_address || {};
    const raw = a.zip || a.pincode || a.postal_code || a.pin_code || a.Pincode || a.PostalCode || '';
    const m = String(raw).match(/\d{6}/);
    return m ? m[0] : '';
}

// Render one EDD summary into a cell: a fastest→slowest date range + cutoff note.
function eddFormatCell(span, s) {
    if (!s || s.serviceable === null || s.error) {
        span.textContent = '—';
        span.className = 'edd-cell text-[11px] text-slate-300';
        return;
    }
    if (s.serviceable === false) {
        span.textContent = 'Not serviceable';
        span.className = 'edd-cell text-[11px] font-semibold text-rose-500';
        span.title = 'No courier services this pincode';
        return;
    }
    // "Dispatch missed" — if current IST time is past the earliest cutoff, today's
    // dispatch slot is gone, so real EDD slips a day. Reflect that in the estimate.
    let bump = 0;
    if (s.earliest_cutoff && /^\d{2}:\d{2}$/.test(s.earliest_cutoff)) {
        const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const [ch, cm] = s.earliest_cutoff.split(':').map(Number);
        const cutoff = new Date(nowIST); cutoff.setHours(ch, cm, 0, 0);
        if (nowIST > cutoff) bump = 1;
    }
    const fast = (s.fastest_days == null ? null : s.fastest_days + bump);
    const slow = (s.slowest_days == null ? null : s.slowest_days + bump);
    const fmt = (d) => {
        if (d == null) return '—';
        const dt = new Date(); dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() + Math.max(0, d));
        return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    };
    const range = (fast != null && slow != null && fast !== slow) ? `${fmt(fast)} – ${fmt(slow)}` : fmt(fast);
    const fastLabel = fast == null ? '' : fast <= 0 ? 'Today' : fast === 1 ? '1 day' : `${fast} days`;
    span.className = 'edd-cell leading-tight inline-block';
    span.title = `${s.courier_count} courier(s)` +
        (s.earliest_cutoff ? ` · dispatch before ${s.earliest_cutoff}${bump ? ' (missed today)' : ''}` : '') +
        (s.cheapest_freight != null ? ` · from ₹${Number(s.cheapest_freight).toFixed(0)}` : '');
    span.innerHTML =
        `<span class="text-xs font-semibold text-slate-700">${range}</span>` +
        (fastLabel ? `<br><span class="text-[10px] ${bump ? 'text-amber-500' : 'text-slate-400'}">${bump ? 'after cutoff' : fastLabel}</span>` : '');
}

let _eddFetchInFlight = false;
// Gather all "…" EDD cells on screen, serve from cache, fetch the rest in one batch.
async function eddEnrichVisible() {
    const spans = Array.from(document.querySelectorAll('span.edd-cell'));
    if (!spans.length) return;

    const misses = new Map(); // "<pin>-<wt>" -> { pincode, weight }
    spans.forEach(span => {
        const pin = span.dataset.pin;
        const wt = span.dataset.wt || '0.5';
        if (!/^\d{6}$/.test(pin || '')) return;
        const key = `${pin}-${wt}`;
        if (eddClientCache[key]) {
            eddFormatCell(span, eddClientCache[key]);
        } else if (!misses.has(key)) {
            misses.set(key, { pincode: pin, weight: Number(wt) });
        }
    });

    if (!misses.size || _eddFetchInFlight) return;
    _eddFetchInFlight = true;
    try {
        // Direct fetch (not fetchApiData) so the global loader doesn't flash on every render.
        const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };
        if (!headers.Authorization) return;
        const r = await fetch('/api/serviceability/edd-batch', {
            method: 'POST', headers,
            body: JSON.stringify({ items: Array.from(misses.values()) })
        });
        if (!r.ok) return;
        const resp = await r.json();
        const results = (resp && resp.results) || {};
        Object.keys(results).forEach(k => { eddClientCache[k] = results[k]; });
        // Re-apply to all matching cells now on screen.
        document.querySelectorAll('span.edd-cell').forEach(span => {
            const key = `${span.dataset.pin}-${span.dataset.wt || '0.5'}`;
            if (eddClientCache[key]) eddFormatCell(span, eddClientCache[key]);
        });
    } catch (e) {
        // leave cells as "…"; a later render will retry
    } finally {
        _eddFetchInFlight = false;
    }
}

function toggleDetails(id) {
    const details = document.getElementById(`details-${id}`);
    const arrow = document.getElementById(`arrow-${id}`);
    if(details) details.classList.toggle('hidden');
    if(arrow) arrow.classList.toggle('rotate-180');
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

// --- FIXED BULK ACTION BAR (ID TYPE FIX) ---
function updateBulkActionBar() {
    let bar = document.getElementById('bulk-action-bar');
    
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-action-bar';
        bar.className = 'fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-[#1e293b] text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-6 z-50 transition-all duration-300 translate-y-24 opacity-0';
        document.body.appendChild(bar);
    }

    const selectedIds = Array.from(selectedOrders);
    const count = selectedIds.length;

    if (count > 0) {
        bar.classList.remove('translate-y-24', 'opacity-0');
        
        // --- FIX: Convert ID to String to ensure match with Set ---
        const selectedObjs = allOrders.filter(o => selectedOrders.has(String(o.originalId)));
        
        // 1. Approve: If Status is New/Unfulfilled AND No Shipment ID
        const canApprove = selectedObjs.filter(o => 
            (o.status === 'New' || o.status === 'Unfulfilled') && !o.shipmentId
        );
        
        // 2. Assign: If Status is Processing OR Has Shipment ID (but no AWB)
        const canAssign = selectedObjs.filter(o => 
            (o.status === 'Processing' || o.shipmentId) && !o.awb
        );
        
        // 3. Label: If Status is Ready/Shipped OR Has AWB
        const canLabel = selectedObjs.filter(o => 
            ['Ready To Ship', 'Shipped', 'In Transit', 'Out For Delivery'].includes(o.status) || o.awb
        );

        let buttonsHtml = '';

        if (canApprove.length > 0) {
            buttonsHtml += `
                <button onclick="handleBulkApprove()" class="text-sm font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-2 transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                    Approve (${canApprove.length})
                </button>`;
        }

        if (canAssign.length > 0) {
            buttonsHtml += `
                <button onclick="handleBulkAssign()" class="text-sm font-bold text-amber-400 hover:text-amber-300 flex items-center gap-2 ml-4 transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                    Assign (${canAssign.length})
                </button>`;
        }

        if (canLabel.length > 0) {
            buttonsHtml += `
                <button onclick="handleBulkLabel()" class="text-sm font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-2 ml-4 transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2.4-9h6m-1.2 13h-3.6a2.4 2.4 0 01-2.4-2.4V8a2.4 2.4 0 012.4-2.4h3.6a2.4 2.4 0 012.4 2.4v9.6a2.4 2.4 0 01-2.4 2.4z"></path></svg>
                    Get Labels (${canLabel.length})
                </button>`;
        }

        // EasyEcom Batch: Always available when orders are selected
        buttonsHtml += `
            <button onclick="handleCreateEasyecomBatch()" class="text-sm font-bold text-cyan-400 hover:text-cyan-300 flex items-center gap-2 ml-4 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path></svg>
                EasyEcom Batch (${count})
            </button>`;

        const hasActions = buttonsHtml.trim() !== '';

        bar.innerHTML = `
            <span class="font-bold text-sm bg-slate-700 px-3 py-1 rounded-full shadow-inner">${count} Selected</span>
            <div class="h-6 w-px bg-slate-600 mx-2"></div>
            ${hasActions ? buttonsHtml : '<span class="text-sm text-slate-400 italic">No actions available</span>'}
            <button onclick="clearSelection()" class="text-slate-400 hover:text-white ml-auto transition-colors p-2 hover:bg-slate-700 rounded-full">
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
        
        // --- THE FIX STARTS HERE ---
        
        // 1. Don't fetch from server. Update local data instead.
        if (successCount > 0) {
            res.success.forEach(item => {
                // Find the order in our local list
                const order = allOrders.find(o => String(o.originalId) === String(item.id));
                if (order) {
                    // Manually attach the shipment ID we just got
                    order.shipmentId = item.shipmentId;
                    // We can add a flag to help the UI know it's done
                    order.localStatus = 'Approved';
                }
            });
            
            // 2. Re-draw the dashboard with our updated local data
            renderAllDashboard();
            clearSelection();
        }
        // --- THE FIX ENDS HERE ---

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
}

// --- EASYECOM BATCH HANDLER ---
async function handleCreateEasyecomBatch() {
    const ids = Array.from(selectedOrders);
    if (ids.length === 0) return;

    // Get order names for confirmation
    const selectedObjs = allOrders.filter(o => selectedOrders.has(String(o.originalId)));
    const orderNames = selectedObjs.map(o => o.id).join(', ');

    if (!confirm(`Create EasyEcom batch with ${ids.length} order(s)?\n\n${orderNames}`)) return;

    // Update the bar button
    const batchBtn = document.querySelector('#bulk-action-bar button[onclick*="EasyecomBatch"]');
    const origText = batchBtn ? batchBtn.innerHTML : '';
    if (batchBtn) {
        batchBtn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2" stroke-dasharray="31.4 31.4" stroke-dashoffset="10"></circle></svg> Creating...`;
        batchBtn.disabled = true;
    }

    try {
        // fetchApiData automatically adds '/api', so this perfectly hits your Express router!
        const res = await fetchApiData('/easyecom/create-batch', "EasyEcom Batch Failed", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: ids })
        });

        if (res.success) {
            let msg = `EasyEcom batch created: ${res.created} order(s) sent`;
            if (res.skipped && res.skipped.length > 0) {
                msg += ` (${res.skipped.length} skipped)`;
            }
            showNotification(msg);
            
            // 1. Clear the checkboxes
            clearSelection();
            
            // 2. Immediately trigger a background refresh so the UI updates
            // This will pull the fresh order data from Supabase and redraw the table 
            // so batched orders drop out of the "Pending" view.
            setTimeout(() => {
                silentRefreshOrders();
            }, 500); 

        } else {
            // fetchApiData usually throws errors to the catch block, but this handles edge cases
            showNotification(res.error || 'EasyEcom batch creation failed', true);
        }
    } catch (e) {
        // Strip out object notation if error is passed weirdly
        const errMessage = typeof e === 'object' ? e.message : e;
        showNotification(`Error: ${errMessage}`, true);
    } finally {
        if (batchBtn) {
            batchBtn.innerHTML = origText;
            batchBtn.disabled = false;
        }
    }
}

// --- MANUAL WORKFLOW HANDLERS ---

// --- UPDATED WORKFLOW HANDLERS (Direct DOM Updates) ---

// --- UPDATED WORKFLOW HANDLERS (With Visual Dashboard Updates) ---

async function handleManualStep1(originalOrderId, uniqueId) {
    const btn = document.getElementById(`btn-step1-${uniqueId}`);
    const originalText = btn ? btn.textContent : "Approve";

    // 1. Visual Feedback: Set button to loading
    if(btn) { btn.textContent = "Processing..."; btn.disabled = true; }

    // Resolve the EasyEcom order ID from the local order data
    const order = allOrders.find(o => String(o.originalId) === String(originalOrderId));
    const easyecomOrderId = order && order.easyecomOrderId;

    if (!easyecomOrderId) {
        if(btn) { btn.textContent = originalText; btn.disabled = false; }
        showNotification("EasyEcom Order ID not found. Sync may still be running — try refreshing.", true);
        return;
    }

    try {
        // Approve = confirm order on EasyEcom using the EasyEcom order ID
        const res = await fetchApiData('/easyecom/confirm-order', "Approval Failed", {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: easyecomOrderId })
        });

        if (res.success) {
            showNotification("Order Confirmed on EasyEcom");

            // Update Local Data State
            const orderIndex = allOrders.findIndex(o => String(o.originalId) === String(originalOrderId));
            if (orderIndex > -1) {
                allOrders[orderIndex].status = 'Processing';
                allOrders[orderIndex].easyecomStatus = 'confirmed';
            }

            // Update button to confirmed state — disable and remove click
            if (btn) {
                btn.textContent = "Confirmed";
                btn.className = "px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded cursor-default border border-emerald-200";
                btn.disabled = true;
                btn.onclick = null;
                btn.removeAttribute('onclick');
            }

            // Update dashboard status badge
            if (order) {
                const row = document.querySelector(`tr[data-order-id="${order.id}"]`);
                if (row) {
                    const badge = row.querySelector('.rounded-full');
                    if (badge) {
                        badge.textContent = 'Processing';
                        badge.className = `px-3 py-1 text-xs font-semibold rounded-full ${getStatusBadge('Processing')}`;
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
        const msg = typeof e === 'string' ? e : e.message || 'Approval failed';
        if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('limit exceeded') || msg.includes('429')) {
            showNotification('EasyEcom rate limit hit — retrying in 30s...', true);
            if (btn) {
                btn.disabled = true;
                let secs = 30;
                btn.textContent = `Wait ${secs}s`;
                const interval = setInterval(() => {
                    secs--;
                    if (secs <= 0) {
                        clearInterval(interval);
                        btn.textContent = originalText;
                        btn.disabled = false;
                    } else {
                        btn.textContent = `Wait ${secs}s`;
                    }
                }, 1000);
            }
        } else {
            if (btn) { btn.textContent = originalText; btn.disabled = false; }
            showNotification(msg, true);
        }
    }
}

// RapidShyp step handlers removed — EasyEcom handles all order processing

async function fetchCodConfirmations() {
    try {
        const res = await fetch('/api/cod-confirmations');
        codConfirmations = await res.json();
        if (codConfirmations.length > 0) {
            const sample = codConfirmations[0];
            const keys = Object.keys(sample).filter(k => !k.startsWith('_') && k !== '__v');
            console.log('[COD] Loaded', codConfirmations.length, 'records. Fields:', keys.join(', '));
        } else {
            console.warn('[COD] No confirmations loaded from DB — ensure cod_confirmation.js sync has run.');
        }
    } catch (e) {
        console.error("Failed to load COD confirmations", e);
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

async function handleAdAnalysisDateChange() {
    const [startDate, endDate] = calculateDateRange(adAnalysisDatePreset, adAnalysisStartDateFilterEl?.value, adAnalysisEndDateFilterEl?.value);
    
    if (startDate && endDate) {
        showLoader();
        const since = startDate.toISOString().split('T')[0];
        const until = endDate.toISOString().split('T')[0];
        // Reuse the Adset endpoint but for Analysis context
        const endpoint = `/get-adset-performance?since=${since}&until=${until}`;

        try {
            const response = await fetchAdsetPerformanceData(endpoint);
            // Store results in the main data variable (shared reuse is fine here)
            adsetPerformanceData = response.adsetPerformance || [];
            
            // Render with the specific dates
            renderAdAnalysis(startDate, endDate);
        } catch (error) { 
            showNotification("Failed to refresh ad data.", true);
        } finally { 
            hideLoader(); 
        }
    }
}

// --- NEW MODULES ---

function renderCustomerSegments(sortKey = 'spent', sortOrder = 'desc') {
    // 1. Calculate Date Range (DD-MM-YYYY Fix included)
    const [start, end] = calculateDateRange(customerDatePreset, customerStartDateFilterEl?.value, customerEndDateFilterEl?.value);
    
    const customerMap = {};
    
    allOrders.forEach(o => {
        // Filter by Date
        if (start && end && o.date) {
            const parts = o.date.split('-');
            const d = new Date(parts[2], parts[1] - 1, parts[0]);
            if (d < start || d > end) return;
        }

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

    // Categories Logic
    const loyal = customers.filter(c => c.count > 2 || c.spent > 5000);
    const repeat = customers.filter(c => c.count === 2);
    const oneTime = customers.filter(c => c.count === 1);

    // Update Counts
    if(document.getElementById('seg-vip-count')) document.getElementById('seg-vip-count').textContent = loyal.length;
    if(document.getElementById('seg-repeat-count')) document.getElementById('seg-repeat-count').textContent = repeat.length;
    if(document.getElementById('seg-new-count')) document.getElementById('seg-new-count').textContent = oneTime.length;

    // Render Chart
    if (customerSegmentChartInstance) customerSegmentChartInstance.destroy();
    if (customerSegmentChartCanvas) {
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
    }

    // Sort & Render List
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

    if (vipCustomerListEl) {
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
}

function toggleCustomerRow(name) {
    const id = `cust-detail-${name.replace(/\s+/g, '-')}`;
    const el = document.getElementById(id);
    if(el) el.classList.toggle('hidden');
}

function renderReturnsAnalysis() {
    const [startDate, endDate] = calculateDateRange(returnsDatePreset, returnsStartDateFilterEl.value, returnsEndDateFilterEl.value);
    
    // 1. Filter for RTO Orders
    let rtoOrders = allOrders.filter(o => o.status === 'RTO');

    // 2. Apply Date Filter
    if (startDate && endDate) {
        rtoOrders = rtoOrders.filter(o => {
            const dateStr = o.rtoDate || o.shipped_at || o.created_at || o.date; 
            if (!dateStr) return false;

            let d;
            if (dateStr.includes('T')) {
                 d = new Date(dateStr); 
            } else {
                 const parts = dateStr.split('-');
                 if (parts.length === 3) d = new Date(parts[2], parts[1] - 1, parts[0]);
                 else return false; 
            }
            return d >= startDate && d <= endDate;
        });
    }

    const totalRTO = rtoOrders.length;
    const rtoRate = allOrders.length > 0 ? (totalRTO / allOrders.length) : 0;

    // --- Update KPI Cards ---
    const kpiRate = document.getElementById('kpi-rto-rate');
    if(kpiRate) kpiRate.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Return Rate</span><span class="text-2xl font-bold text-slate-800 mt-1">${formatPercent(rtoRate)}</span>`;
    
    const kpiCount = document.getElementById('kpi-rto-count');
    if(kpiCount) kpiCount.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Total Returns</span><span class="text-2xl font-bold text-slate-800 mt-1">${totalRTO}</span>`;
    
    const kpiCost = document.getElementById('kpi-rto-cost');
    if(kpiCost) kpiCost.innerHTML = `<span class="text-xs text-slate-500 uppercase font-bold">Est. Loss</span><span class="text-2xl font-bold text-rose-600 mt-1">${formatCurrency(totalRTO * 150)}</span><span class="text-xs text-slate-400">@ ₹150/return</span>`; 

    if(document.getElementById('total-rto-val')) document.getElementById('total-rto-val').textContent = totalRTO;

    // --- Product Analysis ---
    const productCount = {};
    rtoOrders.forEach(o => {
        const items = o.line_items || o.items || [];
        items.forEach(i => {
            let name = i.name || i.title || 'Unknown Product';
            // Clean up name (optional: remove variant info for cleaner chart)
            // name = name.replace(/ - \d+ Month Pack.*/, ''); 
            productCount[name] = (productCount[name] || 0) + 1;
        });
    });
    
    const topProducts = Object.entries(productCount).sort((a,b) => b[1] - a[1]).slice(0, 5);
    
    if (rtoProductChartInstance) rtoProductChartInstance.destroy();
    if (rtoProductChartCanvas) {
        rtoProductChartInstance = new Chart(rtoProductChartCanvas, {
            type: 'bar',
            data: {
                labels: topProducts.map(p => p[0].substring(0, 20) + '...'),
                datasets: [{
                    label: 'Returns',
                    data: topProducts.map(p => p[1]),
                    backgroundColor: '#f43f5e',
                    borderRadius: 4,
                    barThickness: 20
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { grid: { display: false } }, y: { grid: { display: false } } }
            }
        });
    }

    // --- City Analysis (STRICT MODE) ---
    const cityCount = {};
    rtoOrders.forEach(o => {
        let city = 'UNKNOWN';

        // STRICT CHECK: Only look for the valid JSON field
        if (o.shipping_address && o.shipping_address.city) {
            city = o.shipping_address.city.trim().toUpperCase();
        } 
        
        // Exclude empty or really short invalid strings
        if (city.length > 2) {
            cityCount[city] = (cityCount[city] || 0) + 1;
        }
    });

    const topCities = Object.entries(cityCount).sort((a,b) => b[1] - a[1]).slice(0, 10);
    
    if(rtoCityListEl) {
        rtoCityListEl.innerHTML = topCities.map(c => `
            <tr class="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                <td class="py-3 px-6 text-sm font-medium text-slate-700">${c[0]}</td>
                <td class="py-3 px-6 text-center text-sm font-bold text-rose-600">${c[1]}</td>
                <td class="py-3 px-6 text-right text-xs text-slate-500 font-mono">${totalRTO > 0 ? formatPercent(c[1]/totalRTO) : '0%'}</td>
            </tr>
        `).join('');
    }
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

// --- UPDATED AD ANALYSIS (Deep Search Matching) ---
function renderAdAnalysis(startDate, endDate) {
    if (!startDate || !endDate) {
        [startDate, endDate] = calculateDateRange(adAnalysisDatePreset, adAnalysisStartDateFilterEl?.value, adAnalysisEndDateFilterEl?.value);
    }

    const paymentFilter = adAnalysisPaymentFilter ? adAnalysisPaymentFilter.value : 'All';

    let filteredOrders = allOrders;
    if (startDate && endDate) {
        filteredOrders = allOrders.filter(o => {
            if (!o.date) return false;
            const parts = o.date.split('-');
            const d = new Date(parts[2], parts[1] - 1, parts[0]);
            return d >= startDate && d <= endDate;
        });
    }

    const analysisData = adsetPerformanceData.map(ad => {
        // --- THE FIX: DEEP SEARCH MATCHING ---
        // We look for the Ad Name inside Tags, Landing Site, Referring Site, or Note Attributes
        const matchedOrders = filteredOrders.filter(o => {
            // Create a giant string of all tracking data available on the order
            const orderMetadata = (
                (o.tags || '') + " " +
                (o.landing_site || '') + " " +
                (o.referring_site || '') + " " +
                (JSON.stringify(o.note_attributes || []))
            ).toLowerCase();

            // Check if the Ad Name exists anywhere in that data
            return orderMetadata.includes(ad.name.toLowerCase());
        });
        
        let relatedOrders = matchedOrders.length > 0 ? matchedOrders : [];

        if (paymentFilter !== 'All') {
            relatedOrders = relatedOrders.filter(o => {
                const pm = (o.paymentMethod || '').toUpperCase();
                return pm.includes(paymentFilter.toUpperCase()) || (paymentFilter === 'PREPAID' && !pm.includes('COD'));
            });
        }

        const codCount = relatedOrders.filter(o => (o.paymentMethod || '').toLowerCase().includes('cod')).length;
        const prepaidCount = relatedOrders.filter(o => !(o.paymentMethod || '').toLowerCase().includes('cod')).length;
        const totalConversions = codCount + prepaidCount;
        
        // Clicks: Use backend data if available, else fallback estimate
        const clicks = ad.clicks || (ad.spend ? Math.floor(ad.spend / 15) : 0) || 0;
        
        const convRate = clicks > 0 ? (totalConversions / clicks) * 100 : 0;
        const codShare = totalConversions > 0 ? (codCount / totalConversions) * 100 : 0;
        const prepaidShare = totalConversions > 0 ? (prepaidCount / totalConversions) * 100 : 0;

        return {
            name: ad.name,
            clicks: clicks,
            conversions: totalConversions,
            convRate: convRate,
            cod: codCount,
            codShare: codShare,
            prepaid: prepaidCount,
            prepaidShare: prepaidShare
        };
    }).sort((a,b) => b.conversions - a.conversions);

    if(adAnalysisTableBody) {
        adAnalysisTableBody.innerHTML = analysisData.map(d => `
            <tr class="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                <td class="p-4 font-semibold text-slate-800 text-xs md:text-sm">
                    ${d.name}
                </td>
                <td class="p-4 text-slate-500 font-mono text-sm">
                    ${formatNumber(d.clicks)}
                </td>
                <td class="p-4">
                    <div class="flex flex-col">
                        <span class="font-bold text-indigo-700 text-sm">${formatNumber(d.conversions)}</span>
                        <span class="text-[10px] text-slate-400">CVR: ${d.convRate.toFixed(2)}%</span>
                    </div>
                </td>
                <td class="p-4">
                    <div class="flex flex-col">
                        <span class="font-bold text-rose-600 text-sm">${formatNumber(d.cod)}</span>
                        <span class="text-[10px] text-slate-400">${d.codShare.toFixed(1)}%</span>
                    </div>
                </td>
                <td class="p-4">
                    <div class="flex flex-col">
                        <span class="font-bold text-emerald-600 text-sm">${formatNumber(d.prepaid)}</span>
                        <span class="text-[10px] text-slate-400">${d.prepaidShare.toFixed(1)}%</span>
                    </div>
                </td>
            </tr>
        `).join('');
    }
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
function renderAllInsights() {
    const [s, e] = calculateDateRange(insightsDatePreset, insightsStartDateFilterEl.value, insightsEndDateFilterEl.value);
    let o = [...allOrders];

    if (s && e) {
        o = o.filter(t => {
            if (!t.date) return false;
            // FIX: Parse DD-MM-YYYY string to Date Object manually
            const parts = t.date.split('-'); // [28, 12, 2025]
            const d = new Date(parts[2], parts[1] - 1, parts[0]); // Year, Month-1, Day
            return d >= s && d <= e;
        });
    }

    if (insightsPlatformFilter !== 'All') {
        o = o.filter(t => t.platform === insightsPlatformFilter);
    }

    renderInsightsPlatformFilters();
    
    // Pass the date range to metrics so it can calculate "Previous Period" correctly
    const t = calculateComparisonMetrics(o, allOrders, insightsDatePreset, s, e);
    
    updateInsightsKpis(o, t);
    renderInsightCharts(o, s, e);
}
function calculateDateRange(p, s, e) {
    // 1. Get Current Time in Browser (Local Time)
    const now = new Date();
    // Start of "Today" (Midnight 00:00:00)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    
    let a, d;

    switch (p) {
        case 'today':
            a = new Date(startOfToday); 
            d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            break;
        case 'yesterday':
            a = new Date(startOfToday);
            a.setDate(startOfToday.getDate() - 1);
            d = new Date(startOfToday);
            d.setMilliseconds(-1); // End of yesterday
            break;
        case 'last_7_days':
            a = new Date(startOfToday);
            a.setDate(startOfToday.getDate() - 6);
            d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            break;
        case 'mtd': // Month to Date
            a = new Date(now.getFullYear(), now.getMonth(), 1);
            d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            break;
        case 'last_month':
            a = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            d = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            break;
        case 'custom':
            if (!s) return [null, null];
            // FIX: Parse DD-MM-YYYY input from date picker
            // Note: HTML date inputs usually return YYYY-MM-DD regardless of display. 
            // If your input is text DD-MM-YYYY, use this:
            // const [sd, sm, sy] = s.split('-').map(Number);
            
            // If using <input type="date">, it is ALWAYS YYYY-MM-DD in value
            const [sy, sm, sd] = s.split('-').map(Number);
            a = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
            
            if (e) {
                const [ey, em, ed] = e.split('-').map(Number);
                d = new Date(ey, em - 1, ed, 23, 59, 59, 999);
            } else {
                d = new Date(a);
                d.setHours(23, 59, 59, 999);
            }
            break;
        default:
            return [null, null];
    }
    
    return [a, d];
}
function calculateComparisonMetrics(currentPeriodOrders, allData, preset, currentStart, currentEnd) {
    let prevStart, prevEnd, label = '';
    
    if (!currentStart || !currentEnd) return { periodLabel: '', revenueTrend: '', ordersTrend: '' };

    const platformFilteredAll = insightsPlatformFilter === 'All' ? allData : allData.filter(r => r.platform === insightsPlatformFilter);

    // Calculate Previous Period Dates
    switch (preset) {
        case 'last_7_days':
            prevStart = new Date(currentStart);
            prevStart.setDate(currentStart.getDate() - 7);
            prevEnd = new Date(currentEnd);
            prevEnd.setDate(currentEnd.getDate() - 7);
            label = 'vs Previous Week';
            break;
        case 'mtd':
        case 'last_month':
            prevStart = new Date(currentStart);
            prevStart.setMonth(currentStart.getMonth() - 1);
            prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth() + 1, 0); // End of that previous month
            prevEnd.setHours(23, 59, 59, 999);
            label = 'vs Previous Month';
            break;
        default:
            return { periodLabel: '', revenueTrend: '', ordersTrend: '' };
    }

    // Filter "Previous Period" Orders using DD-MM-YYYY Fix
    const prevOrders = platformFilteredAll.filter(i => {
        if (!i.date) return false;
        const parts = i.date.split('-');
        const n = new Date(parts[2], parts[1] - 1, parts[0]);
        return n >= prevStart && n <= prevEnd;
    });

    // Calculate Metrics
    const currRevenue = currentPeriodOrders.filter(i => i.status !== 'Cancelled').reduce((n, i) => n + (parseFloat(i.total)||0), 0);
    const prevRevenue = prevOrders.filter(i => i.status !== 'Cancelled').reduce((n, i) => n + (parseFloat(i.total)||0), 0);

    const formatTrend = (curr, prev) => {
        if (prev === 0) return curr > 0 ? '+100%' : '0%';
        const v = ((curr - prev) / prev) * 100;
        return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    };

    return {
        periodLabel: label,
        revenueTrend: formatTrend(currRevenue, prevRevenue),
        ordersTrend: formatTrend(currentPeriodOrders.length, prevOrders.length)
    };
}
// --- UPDATED KPI LOGIC (Fixing RTO vs In Transit) ---
function updateDashboardKpis(o) {
    // 1. Initialize Counters
    const k = { all: 0, newGroup: 0, shippedGroup: 0, delivered: 0, failedGroup: 0 };

    o.forEach(s => {
        k.all++; // Total Count
        
        // Normalize status for easier checking
        const status = s.status; 
        const statusUpper = (status || '').toUpperCase();

        // Group 1: New + Processing (Pending Action)
        if (status === 'New' || status === 'Processing') {
            k.newGroup++;
        }
        
        // Group 4: Failed (Cancelled + ANY RTO Status)
        // Checks if status is 'Cancelled' OR contains 'RTO' (e.g., "RTO Initiated", "RTO In Transit")
        else if (status === 'Cancelled' || statusUpper.includes('RTO')) {
            k.failedGroup++;
        }

        // Group 3: Completed
        else if (status === 'Delivered') {
            k.delivered++;
        }

        // Group 2: Moving (Ready To Ship + Shipped + In Transit + Out For Delivery)
        // MUST EXCLUDE RTO here to prevent double counting
        else if (['Ready To Ship', 'Shipped', 'In Transit', 'Out For Delivery'].includes(status)) {
            // Extra safety: only count if it does NOT have RTO in the name
            if (!statusUpper.includes('RTO')) {
                k.shippedGroup++;
            }
        }
    });

    // 2. Helper to Render Cards
    const renderKpi = (e, t, v, i, subText = "") => {
        if(!e) return;
        e.innerHTML = `
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">${t}</p>
                    <p class="text-2xl font-bold text-slate-800 mt-1">${v}</p>
                    ${subText ? `<p class="text-[9px] text-slate-400 mt-0.5">${subText}</p>` : ''}
                </div>
                <div class="p-2 bg-slate-50 rounded-lg">${i}</div>
            </div>`;
    };

    // 3. Render the 5 Cards
    // Card 1: All Orders
    renderKpi(dashboardKpiElements.all, 'Total Orders', k.all, 
        `<svg class="w-6 h-6 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>`
    );

    // Card 2: Pending (New / Processing)
    renderKpi(dashboardKpiElements.newOrders, 'New / Processing', k.newGroup, 
        `<svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        "Action Required"
    );

    // Card 3: In Transit (Shipped / Ready - EXCLUDES RTO)
    renderKpi(dashboardKpiElements.shipped, 'In Transit', k.shippedGroup, 
        `<svg class="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`,
        "On the way"
    );

    // Card 4: Delivered
    renderKpi(dashboardKpiElements.delivered, 'Delivered', k.delivered, 
        `<svg class="w-6 h-6 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        "Completed"
    );

    // Card 5: Failed (Cancelled / RTO - INCLUDES ALL RTO TYPES)
    renderKpi(dashboardKpiElements.cancelled, 'Cancelled / RTO', k.failedGroup, 
        `<svg class="w-6 h-6 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        "Attention Needed"
    );
}
function updateInsightsKpis(o, c) {
    // 1. Calculate Status Counts
    const counts = {
        pending: 0, // New + Processing
        moving: 0,  // Ready + Shipped + Transit + OFD
        delivered: 0,
        rto: 0,
        cancelled: 0,
        total: o.length
    };

    // Calculate Financials (Exclude Cancelled)
    const validOrders = o.filter(s => s.status !== 'Cancelled');
    const totalRevenue = validOrders.reduce((sum, r) => sum + (parseFloat(r.total) || 0), 0);
    const avgValue = validOrders.length > 0 ? totalRevenue / validOrders.length : 0;

    o.forEach(s => {
        if (s.status === 'New' || s.status === 'Processing') {
            counts.pending++;
        }
        else if (['Ready To Ship', 'Shipped', 'In Transit', 'Out For Delivery'].includes(s.status)) {
            counts.moving++;
        }
        else if (s.status === 'Delivered') {
            counts.delivered++;
        }
        else if (s.status === 'RTO') {
            counts.rto++;
        }
        else if (s.status === 'Cancelled') {
            counts.cancelled++;
        }
    });

    // 2. Render Helper
    const renderKpi = (e, label, value, icon, trend, labelTrend) => {
        if (!e) return;
        const trendColor = trend && trend.startsWith('+') ? 'text-emerald-500' : 'text-rose-500';
        e.innerHTML = `
            <div class="flex items-center">
                ${icon}
                <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide ml-2">${label}</p>
            </div>
            <p class="text-2xl font-bold text-slate-900 mt-2">${value}</p>
            ${trend ? `<p class="text-xs ${trendColor} mt-1 font-medium">${trend} <span class="text-slate-400 font-normal">${labelTrend}</span></p>` : `<p class="text-xs text-slate-400 mt-1">&nbsp;</p>`}
        `;
    };

    // 3. Render All 8 Cards
    renderKpi(insightsKpiElements.revenue.el, 'Total Revenue', formatCurrency(totalRevenue),
        `<svg class="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v.01"></path></svg>`,
        c.revenueTrend, c.periodLabel
    );

    renderKpi(insightsKpiElements.avgValue.el, 'Avg. Order Value', formatCurrency(avgValue),
        `<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 6h10a2 2 0 001.79-1.11L21 8M6 18h12a2 2 0 002-2v-5a2 2 0 00-2-2H6a2 2 0 00-2 2v5a2 2 0 002 2z"></path></svg>`,
        '', ''
    );

    renderKpi(insightsKpiElements.allOrders.el, 'Total Orders', counts.total,
        `<svg class="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>`,
        c.ordersTrend, c.periodLabel
    );

    renderKpi(insightsKpiElements.new.el, 'Pending Processing', counts.pending,
        `<svg class="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        '', ''
    );

    renderKpi(insightsKpiElements.shipped.el, 'In Transit', counts.moving,
        `<svg class="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`,
        '', ''
    );

    // --- ADDED DELIVERED CARD ---
    renderKpi(insightsKpiElements.delivered.el, 'Delivered', counts.delivered,
        `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        '', ''
    );
    // ----------------------------

    renderKpi(insightsKpiElements.rto.el, 'RTO', counts.rto,
        `<svg class="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
        '', ''
    );

    renderKpi(insightsKpiElements.cancelled.el, 'Cancelled', counts.cancelled,
        `<svg class="w-5 h-5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`,
        '', ''
    );
}
function renderInsightCharts(o, s, e) {
    if (revenueChartInstance) revenueChartInstance.destroy();
    if (platformChartInstance) platformChartInstance.destroy();
    if (paymentChartInstance) paymentChartInstance.destroy();

    // 1. Prepare Date Keys (YYYY-MM-DD) for the X-Axis
    const dateMap = {};
    if (s && e) {
        let curr = new Date(s);
        while (curr <= e) {
            // Key format: YYYY-MM-DD (standard for sorting/charts)
            const key = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');
            dateMap[key] = 0;
            curr.setDate(curr.getDate() + 1);
        }
    }

    // 2. Populate Data
    o.forEach(r => {
        if (r.status !== 'Cancelled' && r.date) {
            // FIX: Parse DD-MM-YYYY -> Convert to YYYY-MM-DD Key
            const parts = r.date.split('-'); // [28, 12, 2025]
            // Create YYYY-MM-DD string directly manually
            const key = `${parts[2]}-${parts[1]}-${parts[0]}`; 
            
            if (dateMap[key] !== undefined) {
                dateMap[key] += (parseFloat(r.total) || 0);
            }
        }
    });

    // 3. Render Revenue Chart
    revenueChartInstance = new Chart(revenueChartCanvas, {
        type: 'line',
        data: {
            // Display labels: Dec 28
            labels: Object.keys(dateMap).map(l => {
                const p = l.split('-');
                const d = new Date(p[0], p[1]-1, p[2]);
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }),
            datasets: [{
                label: 'Revenue',
                data: Object.values(dateMap),
                borderColor: '#4f46e5',
                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { title: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: '#f1f5f9' } }
            }
        }
    });

    // 4. Render Platform Chart
    const pCounts = { Shopify: 0, Amazon: 0 };
    o.forEach(r => {
        if (r.status !== 'Cancelled' && pCounts[r.platform] !== undefined) {
            pCounts[r.platform] += (parseFloat(r.total) || 0);
        }
    });

    platformChartInstance = new Chart(platformChartCanvas, {
        type: 'doughnut',
        data: {
            labels: Object.keys(pCounts),
            datasets: [{
                data: Object.values(pCounts),
                backgroundColor: ['#10b981', '#f59e0b']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { title: { display: false } }
        }
    });

    // 5. Render Payment Chart
    const mCounts = { Prepaid: 0, COD: 0 };
    o.forEach(r => {
        if (r.paymentMethod) {
            const i = r.paymentMethod.toLowerCase();
            if (i.includes("cod") || i.includes("cash")) {
                mCounts.COD++;
            } else {
                mCounts.Prepaid++;
            }
        }
    });

    paymentChartInstance = new Chart(paymentChartCanvas, {
        type: 'doughnut',
        data: {
            labels: Object.keys(mCounts),
            datasets: [{
                data: Object.values(mCounts),
                backgroundColor: ['#6366f1', '#f43f5e']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: false },
                tooltip: {
                    callbacks: {
                        label: c => {
                            const t = c.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                            const p = t > 0 ? ((c.raw / t) * 100).toFixed(1) + '%' : '0%';
                            return `${c.label}: ${c.raw} (${p})`;
                        }
                    }
                }
            }
        }
    });
}
function renderSettings(){const c=document.getElementById('seller-connections');c.innerHTML=connections.map(e=>`<div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between"><div class="flex items-center"><img src="${platformLogos[e.name]}" class="w-10 h-10 mr-4 rounded-lg bg-slate-50 p-1"><div><p class="font-bold text-slate-900">${e.name}</p><p class="text-sm text-slate-500">${e.status==='Connected'?e.user:'Click to connect'}</p></div></div><button data-platform="${e.name}" data-action="${e.status==='Connected'?'disconnect':'connect'}" class="connection-btn ${e.status==='Connected'?'text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100':'text-white bg-indigo-600 hover:bg-indigo-700'} px-4 py-2 rounded-lg text-sm font-medium transition-colors">${e.status==='Connected'?'Disconnect':'Connect'}</button></div>`).join('');document.querySelectorAll('.connection-btn').forEach(b=>b.addEventListener('click',e=>handleConnection(e.currentTarget.dataset.platform,e.currentTarget.dataset.action)))}
function handleConnection(p,a){if(a==='connect'){showNotification(`Simulating connection to ${p}...`);setTimeout(()=>{showNotification(`Successfully connected to ${p}.`)},1500)}else if(a==='disconnect'){if(confirm(`Are you sure you want to disconnect from ${p}?`)){showNotification(`Disconnected from ${p}.`)}}}
async function loadInitialData() {
    try {
        // Show loader while fetching both
        if(document.getElementById('loading-overlay')) document.getElementById('loading-overlay').classList.remove('hidden');

        // Fetch Orders AND COD Data in parallel
        const [ordersData, _] = await Promise.all([
            fetchOrdersFromServer(),
            fetchCodConfirmations()
        ]);
        
        allOrders = ordersData;
        
        initializeAllFilters();
        navigate('orders-dashboard');

        // --- COD status refresh every 1 minute ---
        setInterval(async () => {
            try {
                await fetchCodConfirmations();
                if (currentView === 'orders-dashboard') renderAllDashboard();
                else if (currentView === 'order-insights') renderAllInsights();
            } catch (e) { console.error('COD refresh failed:', e); }
        }, 60000);

        // --- Full orders + COD refresh every 1 minute ---
        setInterval(() => silentRefreshOrders(), 60000);

    } catch (error) {
        console.error("Critical Error loading initial data:", error);
    } finally {
        if(document.getElementById('loading-overlay')) document.getElementById('loading-overlay').classList.add('hidden');
    }
}
function initializeAllFilters() {
    // 1. Status Filters
    const statusOptions = ['All Statuses', 'New', 'Processing', 'Ready To Ship', 'Shipped', 'In Transit', 'Delivered', 'RTO', 'Cancelled'];
    statusFilterEl.innerHTML = statusOptions.map(s => `<option value="${s === 'All Statuses' ? 'All' : s}">${s}</option>`).join('');
    statusFilterEl.value = activeStatusFilter;
    statusFilterEl.addEventListener('change', e => { activeStatusFilter = e.target.value; renderAllDashboard(); });

    // 2. Date Definitions
    const d = {
        'today': 'Today',
        'yesterday': 'Yesterday',
        'last_7_days': 'Last 7 Days',
        'mtd': 'Month to Date',
        'last_month': 'Last Month',
        'custom': 'Custom Range...'
    };

    // 3. Initialize ALL Date Filters (Added Customer & Ad Analysis)
    initializeDateFilters(insightsDatePresetFilter, insightsCustomDateContainer, insightsStartDateFilterEl, insightsEndDateFilterEl, 'insightsDatePreset', renderAllInsights, d);
    initializeDateFilters(adsetDatePresetFilter, adsetCustomDateContainer, adsetStartDateFilterEl, adsetEndDateFilterEl, 'adsetDatePreset', () => handleAdsetDateChange(false), d);
    initializeDateFilters(orderDatePresetFilter, customDateContainer, startDateFilterEl, endDateFilterEl, 'activeDatePreset', renderAllDashboard, d);
    initializeDateFilters(profitDatePresetFilter, profitCustomDateContainer, profitStartDateFilterEl, profitEndDateFilterEl, 'profitDatePreset', handleProfitabilityChange, d);
    initializeDateFilters(rankingDatePresetFilter, null, null, null, 'adsetDatePreset', () => handleAdsetDateChange(true), d);
    initializeDateFilters(returnsDatePresetFilter, returnsCustomDateContainer, returnsStartDateFilterEl, returnsEndDateFilterEl, 'returnsDatePreset', renderReturnsAnalysis, d);
    
    // --- NEW FILTERS ---
    initializeDateFilters(customerDatePresetFilter, customerCustomDateContainer, customerStartDateFilterEl, customerEndDateFilterEl, 'customerDatePreset', () => renderCustomerSegments(currentSortKey || 'spent', currentSortOrder || 'desc'), d);
    initializeDateFilters(adAnalysisDatePresetFilter, adAnalysisCustomDateContainer, adAnalysisStartDateFilterEl, adAnalysisEndDateFilterEl, 'adAnalysisDatePreset', handleAdAnalysisDateChange, d);
    
    renderInsightsPlatformFilters();
}

function initializeDateFilters(d, c, s, e, p, h, t) {
    if(!d) return; // Guard clause if element missing in HTML
    
    d.innerHTML = Object.entries(t).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

    // Set Initial Value based on State
    if (p === 'insightsDatePreset') d.value = insightsDatePreset;
    else if (p === 'adPerformanceDatePreset') d.value = adPerformanceDatePreset;
    else if (p === 'adsetDatePreset') d.value = adsetDatePreset;
    else if (p === 'activeDatePreset') d.value = activeDatePreset;
    else if (p === 'profitDatePreset') d.value = profitDatePreset;
    else if (p === 'returnsDatePreset') d.value = returnsDatePreset;
    else if (p === 'customerDatePreset') d.value = customerDatePreset; // New
    else if (p === 'adAnalysisDatePreset') d.value = adAnalysisDatePreset; // New

    const dateChange = () => {
        const v = d.value;
        // Update State
        if (p === 'insightsDatePreset') insightsDatePreset = v;
        else if (p === 'adPerformanceDatePreset') adPerformanceDatePreset = v;
        else if (p === 'adsetDatePreset') adsetDatePreset = v;
        else if (p === 'activeDatePreset') activeDatePreset = v;
        else if (p === 'profitDatePreset') profitDatePreset = v;
        else if (p === 'returnsDatePreset') returnsDatePreset = v;
        else if (p === 'customerDatePreset') customerDatePreset = v; // New
        else if (p === 'adAnalysisDatePreset') adAnalysisDatePreset = v; // New

        if (c) c.classList.toggle('hidden', v !== 'custom');
        h(); // Call Handler
    };

    d.addEventListener('change', dateChange);
    if (s) s.addEventListener('change', h);
    if (e) e.addEventListener('change', h);}

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

// ── Amazon Review Requests ────────────────────────────────────────
const AMZ_DATA_FN   = '/api/amazon/review-data';
const AMZ_SINGLE_FN = '/api/amazon/review-send';
const AMZ_DELAY_MS  = 1200;

let amzOrders = [], amzReqStatus = {}, amzSelected = new Set();
let amzCurrentPreset = '7d', amzDateFrom = null, amzDateTo = null;
let amzOpenOrderId = null, amzReviewLoaded = false;
let amzPaymentFilter = '', amzSkuFilter = '';

function amzRevStartOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function amzRevEndOfDay(d)  { const x=new Date(d); x.setHours(23,59,59,999); return x; }

function amzRevGetDateRange(){
  const now=new Date();
  if(amzCurrentPreset==='7d'){ const f=new Date(now); f.setDate(f.getDate()-6); return{from:amzRevStartOfDay(f).toISOString(),to:amzRevEndOfDay(now).toISOString()}; }
  if(amzCurrentPreset==='mtd'){ const f=new Date(now); f.setDate(1); return{from:amzRevStartOfDay(f).toISOString(),to:amzRevEndOfDay(now).toISOString()}; }
  if(amzCurrentPreset==='lm'){ const f=new Date(now); f.setDate(1); f.setMonth(f.getMonth()-1); const t=new Date(now); t.setDate(0); return{from:amzRevStartOfDay(f).toISOString(),to:amzRevEndOfDay(t).toISOString()}; }
  if(amzCurrentPreset==='custom'&&amzDateFrom&&amzDateTo) return{from:amzRevStartOfDay(new Date(amzDateFrom)).toISOString(),to:amzRevEndOfDay(new Date(amzDateTo)).toISOString()};
  const f=new Date(now); f.setDate(f.getDate()-6); return{from:amzRevStartOfDay(f).toISOString(),to:amzRevEndOfDay(now).toISOString()};
}

function amzRevGetRangeLabel(){
  const{from,to}=amzRevGetDateRange();
  return new Date(from).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+' – '+new Date(to).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'});
}

function amzRevSetPreset(preset,btn){
  amzCurrentPreset=preset;
  document.querySelectorAll('#amazon-review-view .amzrev-preset').forEach(b=>{
    b.classList.remove('active','bg-indigo-500','border-indigo-500','text-white');
    b.classList.add('border-slate-200','bg-white','text-slate-600');
  });
  btn.classList.add('active','bg-indigo-500','border-indigo-500','text-white');
  btn.classList.remove('border-slate-200','bg-white','text-slate-600');
  const cd=document.getElementById('amzrev-custom-dates');
  if(preset==='custom'){
    cd.classList.remove('hidden'); cd.classList.add('flex');
    if(!document.getElementById('amzrev-date-from').value){
      const t=new Date(),f=new Date(t); f.setDate(f.getDate()-6);
      document.getElementById('amzrev-date-from').value=f.toISOString().split('T')[0];
      document.getElementById('amzrev-date-to').value=t.toISOString().split('T')[0];
    }
    amzDateFrom=document.getElementById('amzrev-date-from').value;
    amzDateTo=document.getElementById('amzrev-date-to').value;
  } else { cd.classList.add('hidden'); cd.classList.remove('flex'); }
  amzRevLoadOrders();
}

function amzRevOnCustomDate(){
  amzDateFrom=document.getElementById('amzrev-date-from').value;
  amzDateTo=document.getElementById('amzrev-date-to').value;
  if(amzDateFrom&&amzDateTo) amzRevLoadOrders();
}

function amzRevToast(msg,isErr){
  if(typeof showNotification==='function') showNotification(msg, isErr||false);
}

function amzRevDaysSince(ds){ if(!ds)return null; return Math.floor((Date.now()-new Date(ds).getTime())/86400000); }
function amzRevGetDD(o){ return o.latest_delivery_date||o.earliest_delivery_date||null; }
function amzRevWindowTag(d){
  if(d===null) return{label:'No date', cls:'ar-p-nodate', filter:'nodate'};
  if(d<5)      return{label:'Too fresh',cls:'ar-p-fresh',  filter:'fresh'};
  if(d>30)     return{label:'Too old',  cls:'ar-p-old',    filter:'old'};
  return              {label:'Eligible', cls:'ar-p-eligible',filter:'eligible'};
}
function amzRevDaysCls(d){ return d===null?'ar-days-old':d<5?'ar-days-fresh':d>30?'ar-days-old':'ar-days-ok'; }
function amzRevFmtDate(ds){ return ds?new Date(ds).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}):'—'; }
function amzRevFmtDT(ds){ return ds?new Date(ds).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—'; }
function amzRevIsEligible(o){ const d=amzRevDaysSince(amzRevGetDD(o)); return d!==null&&d>=5&&d<=30&&!amzRevIsCancelled(o)&&amzReqStatus[o.amazon_order_id]?.solicitation_status!=='sent'; }

function amzRevUpdateBulkBar(){
  document.getElementById('amzrev-bulk-info').textContent=amzSelected.size+' order'+(amzSelected.size>1?'s':'')+' selected';
  const bb=document.getElementById('amzrev-bulk-bar');
  if(amzSelected.size>0){ bb.classList.remove('hidden'); bb.classList.add('flex'); }
  else { bb.classList.add('hidden'); bb.classList.remove('flex'); }
}
function amzRevToggleSelect(id,checked){ if(checked)amzSelected.add(id); else amzSelected.delete(id); amzRevUpdateBulkBar(); }
function amzRevToggleAll(cb){
  document.querySelectorAll('#amzrev-tbody .amzrev-row-cb:not(:disabled)').forEach(c=>{c.checked=cb.checked;if(cb.checked)amzSelected.add(c.dataset.id);else amzSelected.delete(c.dataset.id);});
  amzRevUpdateBulkBar();
}
function amzRevSelectAllEligible(){ amzOrders.forEach(o=>{if(amzRevIsEligible(o))amzSelected.add(o.amazon_order_id);}); amzRevRender(); amzRevUpdateBulkBar(); }
function amzRevClearSelection(){ amzSelected.clear(); amzRevRender(); amzRevUpdateBulkBar(); }

// Manual "Retry Failed": re-runs the review check for ONLY orders that previously
// failed (same 10–30 day criteria). Posts the list to Slack and waits for yes/no —
// nothing is sent until someone replies "yes". The daily 10 AM cron is unaffected.
async function amzRevTriggerCron(){
  if(!confirm('Retry review requests for previously-FAILED orders?\n\nThis posts the failed-orders list to Slack and waits for a yes/no reply there. No reviews are sent until you reply "yes". The daily 10 AM auto-run is unaffected.'))return;
  const btn=document.getElementById('amzrev-run-cron-btn');
  const original=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.innerHTML='<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path></svg>Triggering…';}
  try{
    const res=await fetch('/api/amazon/auto-review/trigger',{method:'POST',headers:{ 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' }});
    const d=await res.json().catch(()=>({}));
    if(res.ok && d.success!==false){
      showNotification(d.message || 'Retry-failed check triggered — reply yes/no in Slack.');
    }else{
      showNotification(d.error || 'Failed to trigger retry-failed check.', true);
    }
  }catch(e){
    showNotification('Failed to trigger: '+(e.message||e), true);
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML=original;}
  }
}

async function amzRevLoadOrders(){
  if(amzCurrentPreset==='custom'){
    amzDateFrom=document.getElementById('amzrev-date-from').value;
    amzDateTo=document.getElementById('amzrev-date-to').value;
    if(!amzDateFrom||!amzDateTo)return;
  }
  showLoader();
  document.getElementById('amzrev-ts').textContent='Loading…';
  document.getElementById('amzrev-date-range-lbl').textContent=amzRevGetRangeLabel();
  const{from,to}=amzRevGetDateRange();
  try{
    const res=await fetch(AMZ_DATA_FN,{method:'POST',headers:{ 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },body:JSON.stringify({date_from:from,date_to:to})});
    const d=await res.json();
    if(!d.success)throw new Error(d.error||'Unknown error');
    amzOrders=d.orders||[];
    amzReqStatus={};
    (d.requests||[]).forEach(r=>amzReqStatus[r.order_id]=r);
    amzRevRender(); amzRevUpdateStats();
    document.getElementById('amzrev-ts').textContent='Updated '+new Date().toLocaleTimeString('en-IN',{hour12:false})+' · '+amzOrders.length+' orders';
  }catch(e){
    document.getElementById('amzrev-ts').textContent='Error: '+e.message;
    amzRevToast('Load error: '+e.message,false);
  }finally{
    hideLoader();
  }
}

function amzRevUpdateStats(){
  const m=amzOrders.map(o=>({...o,ddays:amzRevDaysSince(amzRevGetDD(o))}));
  // Only count sent orders that are within the current date-filtered amzOrders set
  const orderIds=new Set(amzOrders.map(o=>o.amazon_order_id));
  const sentIds=new Set(Object.keys(amzReqStatus).filter(k=>amzReqStatus[k].solicitation_status==='sent'&&orderIds.has(k)));
  document.getElementById('amzrev-s-total').textContent=amzOrders.length||'0';
  // Eligible = in 5-30d window AND not sent AND not RTO/Cancelled
  document.getElementById('amzrev-s-elig').textContent=m.filter(o=>o.ddays>=5&&o.ddays<=30&&!sentIds.has(o.amazon_order_id)&&!amzRevIsCancelled(o)).length||'0';
  document.getElementById('amzrev-s-sent').textContent=sentIds.size||'0';
  // Awaiting = too fresh (<5d), not yet in window
  document.getElementById('amzrev-s-fresh').textContent=m.filter(o=>o.ddays!==null&&o.ddays<5&&!sentIds.has(o.amazon_order_id)).length||'0';

  // Show the "Retry Failed" button only when there are failed orders in the current view.
  const failedCount=amzOrders.filter(o=>amzReqStatus[o.amazon_order_id]?.solicitation_status==='failed').length;
  const cronBtn=document.getElementById('amzrev-run-cron-btn');
  if(cronBtn)cronBtn.style.display=failedCount>0?'':'none';
}

function amzRevBuildDetailHTML(orderId){
  const order=amzOrders.find(o=>o.amazon_order_id===orderId);
  const req=amzReqStatus[orderId];
  const ddays=order?amzRevDaysSince(amzRevGetDD(order)):null;
  const ddColor=ddays!==null&&ddays>=5&&ddays<=30?'text-emerald-600':ddays!==null&&ddays<5?'text-amber-600':'text-slate-400';
  const stBadge=req
    ?`<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${req.solicitation_status==='sent'?'bg-emerald-100 text-emerald-700':'bg-rose-100 text-rose-700'}">${req.solicitation_status.toUpperCase()}</span>`
    :`<span class="text-slate-400 text-sm">Not attempted</span>`;
  let responseHTML=`<p class="text-xs text-slate-400 italic">No API call made for this order yet.</p>`;
  if(req&&req.response_code){
    const isOk=req.response_code===200||req.response_code===201;
    let body=req.response_body||'{}';
    try{body=JSON.stringify(JSON.parse(body),null,2);}catch(e){}
    responseHTML=`
      <span class="inline-block mb-2 px-2 py-0.5 rounded text-xs font-bold font-mono ${isOk?'bg-emerald-100 text-emerald-700':'bg-rose-100 text-rose-700'}">HTTP ${req.response_code} ${isOk?'✓ Success':'✗ Error'}</span>
      <pre class="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 mt-1 overflow-auto max-h-24 leading-relaxed font-mono whitespace-pre-wrap break-all">${body.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <p class="text-xs text-slate-400 mt-2">${isOk?'Amazon accepted — buyer receives review email within 24–48 hrs.':'Amazon rejected — see body for reason.'}</p>`;
  }
  // Payment info
  const payMethod=order?.payment_method||order?.payment_method_detail||order?.payment_type||order?.paymentMethod||null;
  const isCOD=order?amzRevIsCOD(order):false;
  const hasPayData=order?amzRevHasPaymentData(order):false;
  const payLabel=!hasPayData?'Not available in sync data'
    :isCOD?'COD (Cash on Delivery)'
    :payMethod==='Other'?'Prepaid / Card'
    :payMethod;
  const payColor=!hasPayData?'text-slate-400 italic':isCOD?'text-amber-600':'text-indigo-600';
  // SKU info
  let skuHTML='—';
  if(order){
    if(Array.isArray(order.order_items)&&order.order_items.length){
      skuHTML=order.order_items.map(i=>{
        const sku=i.seller_sku||i.sku||i.asin||'?';
        const name=i.product_name;
        const master=i.master_sku&&i.master_sku!==sku?` <span class="text-slate-400">(${i.master_sku})</span>`:'';
        return name
          ?`<div class="mb-1"><span class="inline-block px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-xs font-medium mr-1">${name}</span><span class="font-mono text-[11px] text-slate-400">${sku}</span>${master}</div>`
          :`<div class="mb-1"><span class="inline-block px-1.5 py-0 rounded bg-slate-100 text-slate-600 font-mono text-xs">${sku}</span></div>`;
      }).join('');
    } else if(order.seller_sku||order.sku||order.asin){
      skuHTML=`<span class="inline-block px-1.5 py-0 rounded bg-slate-100 text-slate-600 font-mono text-xs">${order.seller_sku||order.sku||order.asin}</span>`;
    }
  }
  // Order status
  const ordStatusBadge=order?amzRevOrderStatusBadge(order):'—';
  return`<div class="amzrev-detail-inner px-8 py-5">
    <div class="grid grid-cols-3 gap-3 mb-3">
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Purchase date</p>
        <p class="text-sm font-semibold text-slate-700">${amzRevFmtDate(order?.purchase_date)}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Delivery date</p>
        <p class="text-sm font-semibold text-slate-700">${amzRevFmtDate(amzRevGetDD(order))}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Days since delivery</p>
        <p class="text-sm font-semibold ${ddColor}">${ddays!==null?ddays+' days':'—'}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Amount</p>
        <p class="text-sm font-semibold text-slate-700">${order?.order_total_amount?'₹'+Number(order.order_total_amount).toLocaleString('en-IN'):'—'}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Payment mode</p>
        <p class="text-sm font-semibold ${payColor}">${payLabel}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Order status</p>
        <div class="mt-0.5">${ordStatusBadge}</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3 col-span-2">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">SKU(s)</p>
        <div class="mt-0.5">${skuHTML}</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Solicitation status</p>
        <div class="mt-0.5">${stBadge}</div>
      </div>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 p-3 mb-3">
      <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Attempted at</p>
      <p class="text-sm font-semibold text-slate-700">${req?.attempted_at?amzRevFmtDT(req.attempted_at):'—'}</p>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Amazon API response</p>
      ${responseHTML}
    </div>
  </div>`;
}

function amzRevToggleDetail(orderId){
  if(amzOpenOrderId===orderId){
    const dr=document.getElementById('amzrev-dr-'+orderId); if(dr)dr.remove();
    const mr=document.getElementById('amzrev-row-'+orderId); if(mr)mr.classList.remove('amzrev-row-active');
    amzOpenOrderId=null; return;
  }
  if(amzOpenOrderId){
    const pdr=document.getElementById('amzrev-dr-'+amzOpenOrderId); if(pdr)pdr.remove();
    const pmr=document.getElementById('amzrev-row-'+amzOpenOrderId); if(pmr)pmr.classList.remove('amzrev-row-active');
  }
  amzOpenOrderId=orderId;
  const mainRow=document.getElementById('amzrev-row-'+orderId); if(!mainRow)return;
  mainRow.classList.add('amzrev-row-active');
  const detailTr=document.createElement('tr'); detailTr.className='amzrev-detail-row'; detailTr.id='amzrev-dr-'+orderId;
  const detailTd=document.createElement('td'); detailTd.colSpan=11; detailTd.innerHTML=amzRevBuildDetailHTML(orderId);
  detailTr.appendChild(detailTd); mainRow.insertAdjacentElement('afterend',detailTr);
}

// Window tag returns Tailwind badge classes
function amzRevWindowTag(d){
  if(d===null) return{label:'No date',   badge:'bg-slate-100 text-slate-500',  filter:'nodate'};
  if(d<5)      return{label:'Too fresh', badge:'bg-amber-100 text-amber-700',   filter:'fresh'};
  if(d>30)     return{label:'Too old',   badge:'bg-slate-100 text-slate-400',   filter:'old'};
  return              {label:'Eligible', badge:'bg-emerald-100 text-emerald-700',filter:'eligible'};
}
function amzRevDaysCls(d){ return d===null?'text-slate-400':d<5?'text-amber-600 font-semibold':d>30?'text-slate-400':'text-emerald-600 font-semibold'; }

// ── Order status helpers ──────────────────────────────────────────────────
function amzRevGetOrderStatus(o){
  return (o.order_status||o.status||o.fulfillment_status||'').toLowerCase();
}
function amzRevIsCancelled(o){
  const s=amzRevGetOrderStatus(o);
  return s.includes('cancel')||s.includes('rto')||s.includes('return')||s==='returned';
}
function amzRevHasPaymentData(o){
  return !!(o.payment_method||o.payment_method_detail||o.payment_type||o.paymentMethod);
}
function amzRevIsCOD(o){
  const p=(o.payment_method||o.payment_method_detail||o.payment_type||o.paymentMethod||'').toLowerCase();
  return p.includes('cod')||p.includes('cash')||p==='cod';
}
function amzRevGetSkus(o){
  if(Array.isArray(o.order_items)) return o.order_items.map(i=>[(i.product_name||'').toLowerCase(),(i.seller_sku||i.sku||i.asin||'').toLowerCase()].join(' ')).join(' ');
  return (o.seller_sku||o.sku||o.asin||'').toLowerCase();
}
function amzRevProductTags(o){
  if(!Array.isArray(o.order_items)||!o.order_items.length){
    const s=o.seller_sku||o.sku||o.asin||'';
    if(!s) return '<span class="text-slate-300 text-xs">—</span>';
    return `<span class="block truncate px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[11px]" title="${s}">${s}</span>`;
  }
  // Show first item name; if multiple items stack compactly
  return o.order_items.map(i=>{
    const name=i.product_name;
    const sku=i.seller_sku||i.sku||i.asin||'';
    const tip=name?`${name} (${sku})`:sku;
    if(name) return `<div class="truncate max-w-full"><span class="inline-block max-w-full truncate px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[11px] font-medium leading-tight" title="${tip}">${name}</span></div>`;
    return `<div class="truncate max-w-full"><span class="inline-block max-w-full truncate px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-[11px] leading-tight" title="${tip}">${sku}</span></div>`;
  }).join('');
}
function amzRevOrderStatusBadge(o){
  const s=amzRevGetOrderStatus(o);
  // Amazon SP-API keeps status "Shipped" even after delivery — infer Delivered from delivery date
  const dd=amzRevGetDD(o);
  const ddays=amzRevDaysSince(dd);
  if(s.includes('cancel')||s==='canceled'||s==='cancelled')
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-700">Cancelled</span>';
  if(s.includes('rto'))
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">RTO</span>';
  if(s.includes('return')||s==='returned'||s==='unfulfillable')
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">Returned</span>';
  // "Shipped" + has a past delivery date → Delivered
  if((s.includes('ship')||s==='shipped')&&dd&&ddays!==null&&ddays>=0)
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Delivered</span>';
  if(s.includes('ship'))
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">Shipped</span>';
  if(s.includes('deliver'))
    return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Delivered</span>';
  if(!s) return '<span class="text-slate-300 text-xs">—</span>';
  return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`;
}

function amzRevSetPaymentFilter(value){
  amzPaymentFilter=value;
  document.querySelectorAll('#amazon-review-view .amzrev-pf').forEach(b=>{
    b.classList.toggle('active', b.dataset.pf===value);
  });
  amzRevRender();
  // Show warning if payment data is missing
  const note=document.getElementById('amzrev-pay-note');
  if(note){
    const hasAnyPayData=amzOrders.some(o=>amzRevHasPaymentData(o));
    note.classList.toggle('hidden', value===''||hasAnyPayData);
  }
}

function amzRevSetStatusFilter(value){
  // Update pill button active state — exclude payment filter buttons
  document.querySelectorAll('#amazon-review-view .amzrev-sf:not(.amzrev-pf)').forEach(b=>{
    b.classList.toggle('active', b.dataset.filter===value);
  });
  // Highlight active KPI card with outline; clear others
  const kpiMap={'':'amzrev-kpi-all','eligible':'amzrev-kpi-eligible','sent':'amzrev-kpi-sent','fresh':'amzrev-kpi-fresh'};
  const colorMap={'':'kpi-active','eligible':'kpi-active-emerald','sent':'kpi-active-indigo','fresh':'kpi-active-amber'};
  Object.entries(kpiMap).forEach(([k,id])=>{
    const el=document.getElementById(id); if(!el) return;
    el.classList.remove('kpi-active','kpi-active-emerald','kpi-active-indigo','kpi-active-amber');
    if(k===value && colorMap[k]) el.classList.add(colorMap[k]);
  });
  amzRevRender();
}

function amzRevRender(){
  const srch=(document.getElementById('amzrev-srch').value||'').toLowerCase();
  const skuSrch=(document.getElementById('amzrev-sku-srch')?.value||'').toLowerCase();
  // Status filter — exclude payment pills
  const activeBtn=document.querySelector('#amazon-review-view .amzrev-sf:not(.amzrev-pf).active');
  const fw=activeBtn?activeBtn.dataset.filter:'';
  let f=amzOrders.map(o=>({...o,deliveryDate:amzRevGetDD(o),ddays:amzRevDaysSince(amzRevGetDD(o))}));
  // Order ID search
  if(srch) f=f.filter(o=>o.amazon_order_id.toLowerCase().includes(srch));
  // SKU search
  if(skuSrch) f=f.filter(o=>amzRevGetSkus(o).includes(skuSrch));
  // Payment mode filter — only filter if payment data actually exists in order
  if(amzPaymentFilter==='cod')     f=f.filter(o=>amzRevHasPaymentData(o)&&amzRevIsCOD(o));
  if(amzPaymentFilter==='prepaid') f=f.filter(o=>amzRevHasPaymentData(o)&&!amzRevIsCOD(o));
  // Window/status filter
  if(fw){ f=f.filter(o=>{
    const tag=amzRevWindowTag(o.ddays), st=amzReqStatus[o.amazon_order_id]?.solicitation_status;
    if(fw==='sent')     return st==='sent';
    if(fw==='failed')   return st==='failed';
    if(fw==='eligible') return tag.filter==='eligible'&&!amzRevIsCancelled(o);
    return tag.filter===fw;
  });}
  const tb=document.getElementById('amzrev-tbody'),em=document.getElementById('amzrev-empty');
  amzOpenOrderId=null;
  if(!f.length){tb.innerHTML=''; em.classList.remove('hidden'); return;}
  em.classList.add('hidden');
  tb.innerHTML=f.map(o=>{
    const d=o.ddays, tag=amzRevWindowTag(d), st=amzReqStatus[o.amazon_order_id]?.solicitation_status;
    const cancelled=amzRevIsCancelled(o);
    const isCOD=amzRevIsCOD(o);
    const elig=amzRevIsEligible(o), isSel=amzSelected.has(o.amazon_order_id);
    const payBadge=!amzRevHasPaymentData(o)?''
      :isCOD?'<span class="inline-block ml-1 px-1.5 py-0 rounded text-[10px] font-bold bg-amber-100 text-amber-700">COD</span>'
      :'<span class="inline-block ml-1 px-1.5 py-0 rounded text-[10px] font-bold bg-slate-100 text-slate-500">Prepaid</span>';
    const amt=o.order_total_amount?'₹'+Number(o.order_total_amount).toLocaleString('en-IN'):'—';
    const btnBase='px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all';
    let actionBtn;
    if(cancelled)
      actionBtn=`<button class="${btnBase} text-rose-400 border-rose-200 bg-rose-50 cursor-not-allowed" disabled onclick="event.stopPropagation()">Not eligible</button>`;
    else if(st==='sent')
      actionBtn=`<button class="${btnBase} bg-emerald-50 text-emerald-600 border-emerald-200 cursor-default" disabled onclick="event.stopPropagation()">✓ Sent</button>`;
    else if(d===null)
      actionBtn=`<button class="${btnBase} text-slate-400 border-slate-200 cursor-not-allowed" disabled onclick="event.stopPropagation()">No date</button>`;
    else if(d<5)
      actionBtn=`<button class="${btnBase} text-amber-600 border-amber-200 bg-amber-50 cursor-not-allowed" disabled onclick="event.stopPropagation()">Wait ${5-d}d</button>`;
    else if(d>30)
      actionBtn=`<button class="${btnBase} text-slate-400 border-slate-200 cursor-not-allowed" disabled onclick="event.stopPropagation()">Expired</button>`;
    else
      actionBtn=`<button class="${btnBase} bg-indigo-600 hover:bg-indigo-700 text-white border-transparent shadow-sm" id="amzrev-btn-${o.amazon_order_id}" onclick="event.stopPropagation();amzRevSendSingle('${o.amazon_order_id}')">Request review</button>`;
    const stPill=st==='sent'
      ?`<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Sent</span>`
      :st==='failed'
      ?`<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-700">Failed</span>`
      :`<span class="text-slate-300 text-xs">—</span>`;
    return`<tr class="hover:bg-slate-50 cursor-pointer transition-colors" id="amzrev-row-${o.amazon_order_id}" onclick="amzRevToggleDetail('${o.amazon_order_id}')">
      <td class="py-3 px-3" onclick="event.stopPropagation()"><input type="checkbox" class="w-4 h-4 text-indigo-600 rounded border-slate-300 cursor-pointer amzrev-row-cb" data-id="${o.amazon_order_id}" ${!elig?'disabled':''} ${isSel?'checked':''} onchange="amzRevToggleSelect('${o.amazon_order_id}',this.checked)"></td>
      <td class="py-3 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">${o.amazon_order_id}</td>
      <td class="py-3 px-3 overflow-hidden">${amzRevProductTags(o)}</td>
      <td class="py-3 px-3 text-xs text-slate-500 whitespace-nowrap">${amzRevFmtDate(o.purchase_date)}</td>
      <td class="py-3 px-3 text-xs text-slate-500 whitespace-nowrap">${o.deliveryDate?amzRevFmtDate(o.deliveryDate):'—'}</td>
      <td class="py-3 px-3 whitespace-nowrap"><span class="${amzRevDaysCls(d)} text-xs">${d!==null?d+'d':'—'}</span></td>
      <td class="py-3 px-3 text-xs text-slate-700 whitespace-nowrap">${amt}${payBadge}</td>
      <td class="py-3 px-3">${amzRevOrderStatusBadge(o)}</td>
      <td class="py-3 px-3"><span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${tag.badge}">${tag.label}</span></td>
      <td class="py-3 px-3">${stPill}</td>
      <td class="py-3 px-3 text-right pr-5">${actionBtn}</td>
    </tr>`;
  }).join('');
}

async function amzRevSendSingle(orderId){
  const btn=document.getElementById('amzrev-btn-'+orderId);
  const btnBase='px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all';
  if(btn){btn.disabled=true;btn.innerHTML='↻ Sending…';btn.className=btnBase+' bg-amber-50 text-amber-700 border-amber-200 cursor-wait';}
  showLoader();
  try{
    const r=await fetch(AMZ_SINGLE_FN,{method:'POST',headers:{ 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },body:JSON.stringify({order_id:orderId})});
    const d=await r.json();
    amzReqStatus[orderId]={solicitation_status:d.success?'sent':'failed',attempted_at:new Date().toISOString(),response_code:d.status,response_body:d.body};
    if(d.success) amzRevToast('✓ Review request sent for '+orderId, false);
    else{ const msg=(()=>{try{return JSON.parse(d.body)?.errors?.[0]?.message||d.body;}catch(e){return d.body||d.error||'Unknown';}})(); amzRevToast('Failed: '+msg, true); }
    amzSelected.delete(orderId);
    amzRevRender(); amzRevUpdateStats(); amzRevUpdateBulkBar();
    amzRevToggleDetail(orderId);
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML='Request review';btn.className=btnBase+' bg-indigo-600 hover:bg-indigo-700 text-white border-transparent shadow-sm';}
    amzRevToast('Error: '+e.message, true);
  }finally{
    hideLoader();
  }
}

async function amzRevSendBulk(){
  const ids=[...amzSelected]; if(!ids.length)return;
  const btn=document.getElementById('amzrev-bulk-send-btn');
  btn.disabled=true; btn.textContent='↻ Sending…';
  const pw=document.getElementById('amzrev-progress-wrap'),pf=document.getElementById('amzrev-pfill'),pl=document.getElementById('amzrev-progress-lbl');
  pw.classList.remove('hidden'); pf.style.width='0%';
  pf.className='h-full rounded-full transition-all duration-300 bg-indigo-500';
  let done=0,sent=0,failed=0;
  for(const orderId of ids){
    pl.textContent=`Sending ${done+1} of ${ids.length} — ${orderId}`;
    pf.style.width=Math.round((done/ids.length)*100)+'%';
    showLoader();
    try{
      const r=await fetch(AMZ_SINGLE_FN,{method:'POST',headers:{ 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },body:JSON.stringify({order_id:orderId})});
      const d=await r.json();
      amzReqStatus[orderId]={solicitation_status:d.success?'sent':'failed',attempted_at:new Date().toISOString(),response_code:d.status,response_body:d.body};
      if(d.success)sent++;else failed++;
    }catch(e){ amzReqStatus[orderId]={solicitation_status:'failed',attempted_at:new Date().toISOString()}; failed++; }
    finally{ hideLoader(); }
    done++; amzSelected.delete(orderId);
    if(done<ids.length) await new Promise(r=>setTimeout(r,AMZ_DELAY_MS));
  }
  pf.style.width='100%';
  pf.className='h-full rounded-full transition-all duration-300 '+(failed===0?'bg-emerald-500':sent>0?'bg-amber-500':'bg-rose-500');
  pl.textContent=`Done — ${sent} sent, ${failed} failed`;
  amzRevToast(`Bulk complete: ${sent} sent, ${failed} failed`, failed>0);
  setTimeout(()=>pw.classList.add('hidden'),5000);
  btn.disabled=false; btn.textContent='⬆ Send all selected';
  amzRevRender(); amzRevUpdateStats(); amzRevUpdateBulkBar();
}
// ── End Amazon Review Requests ────────────────────────────────────

document.getElementById('nav-reports')?.addEventListener('click', (e) => { e.preventDefault(); navigate('reports-view'); });
document.getElementById('nav-amazon-review')?.addEventListener('click', (e) => { e.preventDefault(); navigate('amazon-review'); });
document.getElementById('nav-fulfillment-ops')?.addEventListener('click', (e) => { e.preventDefault(); navigate('fulfillment-ops'); });
document.getElementById('nav-docpharma-recon')?.addEventListener('click', (e) => { e.preventDefault(); navigate('docpharma-recon'); });
document.getElementById('nav-serviceability')?.addEventListener('click', (e) => { e.preventDefault(); navigate('serviceability'); });
document.getElementById('nav-delivery-perf')?.addEventListener('click', (e) => { e.preventDefault(); navigate('delivery-perf'); });
document.getElementById('nav-ops-control')?.addEventListener('click', (e) => { e.preventDefault(); navigate('ops-control'); });

// ═══════════════ OPS CONTROL (NDR queue · Risk · Courier scorecard · Cost) ═══════════════
let _opsData = null, _opsWired = false, _opsTab = 'ndr', _opsLoaded = {}, _opsRisk = null, _opsCourier = null, _opsCost = null, _opsCostPerRto = 150;
let _opsSortNdr={k:'daysInNdr',d:'desc'}, _opsSortRisk={k:'score',d:'desc'}, _opsSortCourier={k:'shipped',d:'desc'}, _opsSortCity={k:'rtoPct',d:'desc'}, _opsExc=null, _opsSortExc={k:'value',d:'desc'}, _opsPr=null, _opsSortPr={k:'risk',d:'desc'};
const OPS_INR = n => '₹' + (Math.round(n||0)).toLocaleString('en-IN');
// Generic sort: nulls/'—' sink to the bottom; strings use locale compare, numbers numeric.
function opsSortBy(list,st){ const {k,d}=st; return [...list].sort((a,b)=>{ let x=a[k],y=b[k];
    const na=(x==null||x==='—'||(typeof x==='number'&&isNaN(x))), nb=(y==null||y==='—'||(typeof y==='number'&&isNaN(y)));
    if(na&&nb) return 0; if(na) return 1; if(nb) return -1;
    if(typeof x==='string'&&typeof y==='string') return d==='asc'? x.localeCompare(y): y.localeCompare(x);
    return d==='asc'? x-y : y-x; }); }
function opsArrow(st,k){ if(st.k!==k) return '<span class="arw opacity-30">↕</span>'; return `<span class="arw">${st.d==='asc'?'▲':'▼'}</span>`; }
function opsInit(){
    if(!_opsWired){ _opsWired = true;
        document.getElementById('ops-refresh')?.addEventListener('click', ()=>{ _opsLoaded[_opsTab]=false; opsLoadTab(_opsTab); });
        ['ops-search','ops-f-age','ops-f-pay','ops-f-type'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener(id==='ops-search'?'input':'change', ()=>opsTable()); });
        ['ops-risk-search','ops-rf-band','ops-rf-pay'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener(id==='ops-risk-search'?'input':'change', ()=>opsRiskTable()); });
        ['ops-exc-search','ops-ef-action','ops-ef-type'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener(id==='ops-exc-search'?'input':'change', ()=>opsExcTable()); });
        ['ops-pr-search','ops-prf-band'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener(id==='ops-pr-search'?'input':'change', ()=>opsPrTable()); });
        document.getElementById('ops-pr-days')?.addEventListener('change', ()=>opsLoadPrepaidRisk());
        document.getElementById('ops-tabs')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return;
            [...b.parentElement.children].forEach(x=>{ x.classList.remove('bg-indigo-600','text-white'); x.classList.add('text-slate-600'); });
            b.classList.add('bg-indigo-600','text-white'); b.classList.remove('text-slate-600');
            opsSwitchTab(b.dataset.t); });
        // click-to-sort (event delegation — containers persist across re-renders)
        const wireSort=(id,st,rerender)=> document.getElementById(id)?.addEventListener('click', e=>{ const th=e.target.closest('th[data-k]'); if(!th) return;
            const k=th.dataset.k; if(st.k===k){ st.d = st.d==='asc'?'desc':'asc'; } else { st.k=k; st.d='desc'; } rerender(); });
        wireSort('ops-table', _opsSortNdr, ()=>opsTable());
        wireSort('ops-risk-table', _opsSortRisk, ()=>opsRiskTable());
        wireSort('ops-courier-table', _opsSortCourier, ()=>opsCourierTable());
        wireSort('ops-exc-table', _opsSortExc, ()=>opsExcTable());
        wireSort('ops-pr-table', _opsSortPr, ()=>opsPrTable());
        wireSort('ops-cities', _opsSortCity, ()=>opsCitiesTable());
    }
    opsSwitchTab('ndr');
}
function opsSwitchTab(t){ _opsTab=t;
    ['ndr','risk','courier','exceptions','prepaidrisk','cost'].forEach(p=>document.getElementById('ops-'+p)?.classList.toggle('hidden', p!==t));
    opsLoadTab(t);
}
function opsLoadTab(t){ if(_opsLoaded[t] && t!=='ndr') return;
    if(t==='ndr') opsLoad(); else if(t==='risk') opsLoadRisk(); else if(t==='courier') opsLoadCourier(); else if(t==='exceptions') opsLoadExceptions(); else if(t==='prepaidrisk') opsLoadPrepaidRisk(); else if(t==='cost') opsLoadCost();
    _opsLoaded[t]=true;
}
async function opsLoad(){
    const kpi=document.getElementById('ops-kpis'); if(kpi) kpi.innerHTML='<div class="text-slate-400 text-sm p-6">Loading NDR queue…</div>';
    try{
        const r=await fetch('/api/ops-control/ndr-queue?days=45', { headers: getAuthHeaders() });
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsData=d; opsRender(d);
    }catch(e){ if(kpi) kpi.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function opsKpi(label,accent,tint,icon,val,foot){ return `<div class="ops-kpi card p-5" style="border-top:3px solid ${accent}">
    <div class="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style="background:${tint};color:${accent}">${icon}</div>
    <div class="text-[2rem] leading-none font-extrabold text-slate-800 tracking-tight tabular-nums">${val}</div>
    <div class="text-sm font-semibold text-slate-600 mt-1.5">${label}</div>
    <div class="text-xs text-slate-400 mt-0.5">${foot}</div></div>`; }
function opsRender(d){
    const s=d.summary||{};
    const inr=n=>'₹'+(n||0).toLocaleString('en-IN');
    document.getElementById('ops-kpis').innerHTML =
        opsKpi('Orders in NDR','#4f46e5','#eef2ff',DP_ICONS.refresh, s.total||0, 'awaiting a re-attempt / call')+
        opsKpi('Aged ≥ 3 days','#e11d48','#fff1f2',DP_ICONS.bolt, s.aged||0, 'urgent — about to auto-RTO')+
        opsKpi('Recoverable value','#059669','#ecfdf5',DP_ICONS.hash, inr(s.recoverable), `${inr(s.codValue)} of it COD`)+
        opsKpi('Avg time in NDR','#0891b2','#ecfeff',DP_ICONS.hash, (s.avgDays||0)+'d', 'since first failed attempt');
    opsTable();
}
function opsTable(){ const c=document.getElementById('ops-table'); const d=_opsData; if(!d||!c) return;
    const q=(document.getElementById('ops-search')?.value||'').trim().toLowerCase();
    const fAge=document.getElementById('ops-f-age')?.value||'all', fPay=document.getElementById('ops-f-pay')?.value||'all', fType=document.getElementById('ops-f-type')?.value||'all';
    let list=(d.list||[]).slice();
    if(fAge==='urgent') list=list.filter(r=>(r.daysInNdr||0)>=3);
    if(fPay!=='all') list=list.filter(r=> fPay==='cod'? /cod/i.test(r.payment||'') : (r.payment&&!/cod/i.test(r.payment)));
    if(fType!=='all') list=list.filter(r=>r.type===fType);
    if(q) list=list.filter(r=>(r.order||'').toLowerCase().includes(q)||(r.phone||'').toLowerCase().includes(q));
    list=opsSortBy(list,_opsSortNdr);
    const cnt=document.getElementById('ops-count'); if(cnt) cnt.textContent=`${list.length} order${list.length===1?'':'s'}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-10 text-center">Nothing matches — queue is clear 🎉</div>'; return; }
    const td=OPS_TD;
    const H=(k,lbl,extra)=>`<th data-k="${k}" class="${OPS_TH} cursor-pointer ${extra||''}">${lbl}${opsArrow(_opsSortNdr,k)}</th>`;
    const Hp=lbl=>`<th class="${OPS_TH}">${lbl}</th>`;
    const inr=n=>n!=null?'₹'+n.toLocaleString('en-IN'):'—';
    const rows=list.slice(0,500).map(r=>{
        const dn=r.daysInNdr==null?'—':r.daysInNdr+'d';
        const urg=(r.daysInNdr||0)>=4?'bg-red-100 text-red-700':(r.daysInNdr||0)>=2?'bg-amber-100 text-amber-700':'bg-slate-100 text-slate-600';
        const pay=r.payment?`<span class="px-1.5 py-0.5 rounded text-xs ${/cod/i.test(r.payment)?'bg-orange-100 text-orange-700':'bg-emerald-100 text-emerald-700'}">${/cod/i.test(r.payment)?'COD':'Prepaid'}</span>`:'';
        const typ=r.type==='repeat'?'<span class="px-1.5 py-0.5 rounded text-xs bg-violet-100 text-violet-700">Repeat</span>':r.type==='new'?'<span class="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700">New</span>':'';
        const ph=r.phone?`<a href="tel:${r.phone}" class="text-indigo-600 font-medium hover:underline">${r.phone}</a> <a href="https://wa.me/91${String(r.phone).replace(/\D/g,'').slice(-10)}" target="_blank" class="inline-flex items-center text-emerald-600 ml-1" title="WhatsApp">🟢</a>`:'<span class="text-slate-300">no phone</span>';
        return `<tr>`+
          `<td class="${td}"><span class="inline-flex px-2 py-0.5 rounded-md text-xs font-bold ${urg} tabular-nums">${dn}</span></td>`+
          `<td class="${td} font-semibold">${r.order||'—'}<div class="text-xs text-slate-400 font-normal">${r.awb||''}</div></td>`+
          `<td class="${td}">${ph}</td>`+
          `<td class="${td} font-semibold tabular-nums">${inr(r.value)}</td>`+
          `<td class="${td}">${pay} ${typ}</td>`+
          `<td class="${td}">${r.courier||'—'}<div class="text-xs text-slate-400">Zone ${r.zone||'—'}</div></td>`+
          `<td class="${td} text-right tabular-nums">${r.ndrs}</td>`+
          `<td class="${td} text-slate-500 text-xs">${(r.reasons||[]).join('; ')||'—'}</td>`+
        `</tr>`; }).join('');
    const more=list.length>500?`<div class="text-xs text-slate-400 p-3 text-center">Showing first 500 of ${list.length}</div>`:'';
    c.innerHTML=`<table class="w-full"><thead><tr>${H('daysInNdr','Aging')}${H('order','Order / AWB')}${Hp('Customer')}${H('value','Value')}${Hp('Pay / Type')}${H('courier','Courier')}${H('ndrs','NDRs','text-right')}${Hp('Reasons')}</tr></thead><tbody>${rows}</tbody></table>${more}`;
}
const OPS_TH='px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap bg-slate-50/60';
const OPS_TD='px-3 py-2.5 text-sm text-slate-700 border-b border-slate-100 align-middle';

// ── Pre-dispatch Risk ──
async function opsLoadRisk(){
    const k=document.getElementById('ops-risk-kpis'); if(k) k.innerHTML='<div class="text-slate-400 text-sm p-6">Scoring pipeline orders…</div>';
    try{ const r=await fetch('/api/ops-control/risk',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsRisk=d; const s=d.summary||{};
        k.innerHTML =
            opsKpi('Flagged to verify','#e11d48','#fff1f2',DP_ICONS.bolt, s.flagged||0, 'medium + high risk, not yet shipped')+
            opsKpi('High risk','#b91c1c','#fef2f2',DP_ICONS.uturn, s.high||0, 'verify or convert to prepaid')+
            opsKpi('At-risk value (high)','#059669','#ecfdf5',DP_ICONS.hash, OPS_INR(s.atRiskValue), 'order value on high-risk orders');
        opsRiskTable();
    }catch(e){ if(k) k.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function opsRiskTable(){ const c=document.getElementById('ops-risk-table'); const d=_opsRisk; if(!d||!c) return;
    const q=(document.getElementById('ops-risk-search')?.value||'').trim().toLowerCase();
    const fBand=document.getElementById('ops-rf-band')?.value||'all', fPay=document.getElementById('ops-rf-pay')?.value||'all';
    let list=(d.list||[]).slice();
    if(fBand!=='all') list=list.filter(r=>r.band===fBand);
    if(fPay!=='all') list=list.filter(r=> fPay==='cod'? /cod/i.test(r.payment||'') : (r.payment&&!/cod/i.test(r.payment)));
    if(q) list=list.filter(r=> (r.order||'').toLowerCase().includes(q) || (r.city||'').toLowerCase().includes(q));
    list=opsSortBy(list,_opsSortRisk);
    const cnt=document.getElementById('ops-risk-count'); if(cnt) cnt.textContent=`${list.length} order${list.length===1?'':'s'}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-10 text-center">No risky orders match 🎉</div>'; return; }
    const H=(k,lbl)=>`<th data-k="${k}" class="${OPS_TH} bg-slate-50">${lbl}${opsArrow(_opsSortRisk,k)}</th>`;
    const Hp=lbl=>`<th class="${OPS_TH} bg-slate-50">${lbl}</th>`;
    const rows=list.slice(0,500).map(r=>{
        const band=r.band==='High'?'bg-red-100 text-red-700':'bg-amber-100 text-amber-700';
        const pay=r.payment?`<span class="px-1.5 py-0.5 rounded text-xs ${/cod/i.test(r.payment)?'bg-orange-100 text-orange-700':'bg-emerald-100 text-emerald-700'}">${/cod/i.test(r.payment)?'COD':'Prepaid'}</span>`:'';
        const typ=r.type==='repeat'?'<span class="px-1.5 py-0.5 rounded text-xs bg-violet-100 text-violet-700">Repeat</span>':'<span class="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700">New</span>';
        return `<tr>`+
          `<td class="${OPS_TD}"><span class="inline-flex px-2 py-0.5 rounded-md text-xs font-bold ${band}">${r.band} · ${r.score}</span></td>`+
          `<td class="${OPS_TD} font-semibold">${r.order||'—'}<div class="text-xs text-slate-400 font-normal">${r.status||''}</div></td>`+
          `<td class="${OPS_TD} font-semibold tabular-nums">${r.value!=null?OPS_INR(r.value):'—'}</td>`+
          `<td class="${OPS_TD}">${pay} ${typ}</td>`+
          `<td class="${OPS_TD}">${r.city||'—'}<div class="text-xs text-slate-400">${r.state||''}${r.cityRto!=null?` · ${r.cityRto}% RTO`:''}</div></td>`+
          `<td class="${OPS_TD} text-slate-500 text-xs">${(r.reasons||[]).join(' · ')||'—'}</td>`+
        `</tr>`; }).join('');
    const more=list.length>500?`<div class="text-xs text-slate-400 p-3 text-center">Showing first 500 of ${list.length}</div>`:'';
    c.innerHTML=`<table class="w-full"><thead><tr>${H('score','Risk')}${H('order','Order')}${H('value','Value')}${Hp('Pay / Type')}${H('city','Destination')}${Hp('Why flagged')}</tr></thead><tbody>${rows}</tbody></table>${more}`;
}

// ── Courier Scorecard ──
async function opsLoadCourier(){
    const c=document.getElementById('ops-courier-table'); if(c) c.innerHTML='<div class="text-slate-400 text-sm p-6">Loading courier scorecard…</div>';
    try{ const r=await fetch('/api/ops-control/courier-scorecard?days=90',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsCourier=d; opsCourierTable();
    }catch(e){ if(c) c.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function opsCourierTable(){ const c=document.getElementById('ops-courier-table'); const d=_opsCourier; if(!d||!c) return;
    let list=(d.list||[]).slice(); if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-6">No courier data</div>'; return; }
    list=opsSortBy(list,_opsSortCourier);
    const pctCell=(v,badHigh)=>{ const cls=(badHigh? (v>=25?'text-red-600':v>=15?'text-amber-600':'text-emerald-600') : (v>=45?'text-emerald-600':v>=30?'text-amber-600':'text-red-600')); return `<span class="font-bold ${cls} tabular-nums">${v}%</span>`; };
    const H=(k,lbl,r)=>`<th data-k="${k}" class="${OPS_TH} bg-slate-50 ${r?'text-right':''}">${lbl}${opsArrow(_opsSortCourier,k)}</th>`;
    const rows=list.map(r=>`<tr>`+
        `<td class="${OPS_TD} font-semibold">${r.courier}</td>`+
        `<td class="${OPS_TD} text-right tabular-nums">${r.shipped.toLocaleString('en-IN')}</td>`+
        `<td class="${OPS_TD} text-right">${pctCell(r.rtoPct,true)}<div class="text-xs text-slate-400">${r.rto} RTO</div></td>`+
        `<td class="${OPS_TD} text-right">${pctCell(r.ndrRecovery,false)}</td>`+
        `<td class="${OPS_TD} text-right">${pctCell(r.silentPct,true)}<div class="text-xs text-slate-400">${r.silent} silent</div></td>`+
        `<td class="${OPS_TD} text-right tabular-nums">${r.otdAvg}h</td>`+
        `<td class="${OPS_TD} text-right tabular-nums">${r.dtdAvg}d</td>`+
      `</tr>`).join('');
    c.innerHTML=`<table class="w-full"><thead><tr>${H('courier','Courier')}${H('shipped','Shipped',1)}${H('rtoPct','RTO %',1)}${H('ndrRecovery','NDR recovery',1)}${H('silentPct','Silent RTO',1)}${H('otdAvg','O→Dispatch',1)}${H('dtdAvg','Dispatch→Del',1)}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Cost & Hotspots ──
async function opsLoadCost(){
    const k=document.getElementById('ops-cost-kpis'); if(k) k.innerHTML='<div class="text-slate-400 text-sm p-6">Loading…</div>';
    try{ const r=await fetch('/api/ops-control/hotspots?days=90',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsCost=d; opsCostRender();
    }catch(e){ if(k) k.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function opsCostRender(){ const d=_opsCost; if(!d) return;
    const cost=d.rtoCount*_opsCostPerRto;
    document.getElementById('ops-cost-kpis').innerHTML =
        `<div class="ops-kpi card p-5" style="border-top:3px solid #e11d48"><div class="text-[2rem] leading-none font-extrabold text-slate-800 tabular-nums">${OPS_INR(cost)}</div><div class="text-sm font-semibold text-slate-600 mt-1.5">Est. RTO cost · 90d</div><div class="text-xs text-slate-400 mt-1 flex items-center gap-1">${d.rtoCount.toLocaleString('en-IN')} RTO × ₹<input id="ops-cost-per" type="number" value="${_opsCostPerRto}" class="w-16 px-1 py-0.5 border border-slate-200 rounded text-xs tabular-nums"> /order</div></div>`+
        opsKpi('RTO orders · 90d','#4f46e5','#eef2ff',DP_ICONS.uturn, d.rtoCount.toLocaleString('en-IN'), 'returned to origin')+
        opsKpi('Monthly run-rate','#0891b2','#ecfeff',DP_ICONS.hash, OPS_INR(cost/3), 'approx RTO cost / month');
    document.getElementById('ops-cost-per')?.addEventListener('change', e=>{ _opsCostPerRto=parseInt(e.target.value,10)||150; opsCostRender(); });
    // segment mini-cards
    const seg=(title,arr,order)=>{ const rows=(order||arr.map(a=>a.key)).map(key=>{ const it=arr.find(a=>a.key===key); if(!it) return ''; const c=it.rtoPct>=25?'bg-red-500':it.rtoPct>=15?'bg-amber-500':'bg-emerald-500';
        return `<div class="flex items-center gap-2 text-xs mt-1.5"><span class="w-16 text-slate-500">${key}</span><div class="flex-1 h-3.5 bg-slate-100 rounded overflow-hidden"><div class="${c} h-3.5 rounded" style="width:${Math.min(100,it.rtoPct*2)}%"></div></div><span class="w-20 text-right text-slate-600 tabular-nums font-semibold">${it.rtoPct}% <span class="text-slate-400 font-normal">(${it.rto})</span></span></div>`; }).join('');
        return `<div class="card p-4"><h3 class="text-xs font-bold text-slate-600 uppercase tracking-wide">${title}</h3>${rows}</div>`; };
    document.getElementById('ops-segments').innerHTML =
        seg('RTO by payment', d.byPayment, ['COD','Prepaid'])+
        seg('RTO by customer', d.byType, ['new','repeat'])+
        seg('RTO by zone', d.byZone);
    opsCitiesTable();
}
function opsCitiesTable(){ const el=document.getElementById('ops-cities'); const d=_opsCost; if(!el||!d) return;
    let cities=(d.topCities||[]).slice(); if(!cities.length){ el.innerHTML='<div class="text-slate-400 text-sm p-6">No city data</div>'; return; }
    cities=opsSortBy(cities,_opsSortCity);
    const H=(k,lbl,r)=>`<th data-k="${k}" class="${OPS_TH} bg-slate-50 ${r?'text-right':''}">${lbl}${opsArrow(_opsSortCity,k)}</th>`;
    const crows=cities.map(r=>{ const c=r.rtoPct>=30?'text-red-600':r.rtoPct>=20?'text-amber-600':'text-slate-700';
        return `<tr><td class="${OPS_TD} font-semibold">${r.city}</td><td class="${OPS_TD} text-slate-500">${r.state||'—'}</td><td class="${OPS_TD} text-right tabular-nums">${r.resolved}</td><td class="${OPS_TD} text-right tabular-nums">${r.rto}</td><td class="${OPS_TD} text-right"><span class="font-bold ${c} tabular-nums">${r.rtoPct}%</span></td></tr>`; }).join('');
    el.innerHTML=`<table class="w-full"><thead><tr>${H('city','City')}${H('state','State')}${H('resolved','Shipped',1)}${H('rto','RTO',1)}${H('rtoPct','RTO %',1)}</tr></thead><tbody>${crows}</tbody></table>`;
}

// ── Exceptions & Claims ──
async function opsLoadExceptions(){
    const k=document.getElementById('ops-exc-kpis'); if(k) k.innerHTML='<div class="text-slate-400 text-sm p-6">Loading exceptions…</div>';
    try{ const r=await fetch('/api/ops-control/exceptions?days=90',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsExc=d; const s=d.summary||{};
        k.innerHTML =
            opsKpi('Claim from couriers','#e11d48','#fff1f2',DP_ICONS.uturn, OPS_INR(s.claimValue), `${s.claimCount||0} orders · lost / damaged / silent-RTO`)+
            opsKpi('Late-delivery claims','#7c3aed','#f5f3ff',DP_ICONS.bolt, s.slaBreachCount||0, `>5 days past first EDD${s.slaBreachValue?` · ${OPS_INR(s.slaBreachValue)}`:''}`)+
            opsKpi('Redispatch / refund','#4f46e5','#eef2ff',DP_ICONS.refresh, OPS_INR(s.redispatchValue), `${s.redispatchCount||0} prepaid — customer paid, didn't get it`)+
            opsKpi('Misrouted · watch','#d97706','#fffbeb',DP_ICONS.bolt, s.monitorCount||0, 'in transit but off-route');
        const tf=document.getElementById('ops-ef-type'); if(tf){ const cur=tf.value; tf.innerHTML='<option value="all">All types</option>'+Object.keys(s.byType||{}).sort().map(t=>`<option value="${t}">${t} (${s.byType[t]})</option>`).join(''); tf.value=cur; if(tf.value!==cur) tf.value='all'; }
        opsExcTable();
    }catch(e){ if(k) k.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function opsExcTable(){ const c=document.getElementById('ops-exc-table'); const d=_opsExc; if(!d||!c) return;
    const q=(document.getElementById('ops-exc-search')?.value||'').trim().toLowerCase();
    const fA=document.getElementById('ops-ef-action')?.value||'all', fT=document.getElementById('ops-ef-type')?.value||'all';
    let list=(d.list||[]).slice();
    if(fA!=='all') list=list.filter(r=>r.action===fA);
    if(fT!=='all') list=list.filter(r=>r.type===fT);
    if(q) list=list.filter(r=>(r.order||'').toLowerCase().includes(q)||(r.courier||'').toLowerCase().includes(q));
    list=opsSortBy(list,_opsSortExc);
    const cnt=document.getElementById('ops-exc-count'); if(cnt) cnt.textContent=`${list.length} · ${OPS_INR(list.reduce((s,r)=>s+(r.value||0),0))}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-10 text-center">No exceptions match 🎉</div>'; return; }
    const H=(k,lbl,r)=>`<th data-k="${k}" class="${OPS_TH} bg-slate-50 ${r?'text-right':''}">${lbl}${opsArrow(_opsSortExc,k)}</th>`;
    const Hp=lbl=>`<th class="${OPS_TH} bg-slate-50">${lbl}</th>`;
    const tb=t=>{ const m={'Silent RTO':'bg-rose-100 text-rose-700','Lost':'bg-red-100 text-red-700','Damaged':'bg-red-100 text-red-700','Disposed':'bg-red-100 text-red-700','Missing':'bg-red-100 text-red-700','Prepaid RTO':'bg-indigo-100 text-indigo-700','Misrouted':'bg-amber-100 text-amber-700'}; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium ${m[t]||'bg-slate-100 text-slate-600'}">${t}</span>`; };
    const ab=a=> a==='claim'?'<span class="px-1.5 py-0.5 rounded text-xs bg-rose-50 text-rose-700 font-semibold">Claim</span>': a==='redispatch'?'<span class="px-1.5 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700 font-semibold">Redispatch</span>':'<span class="px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700 font-semibold">Monitor</span>';
    const rows=list.slice(0,500).map(r=>{
        const ph=r.phone?`<a href="tel:${r.phone}" class="text-indigo-600 hover:underline">${r.phone}</a>`:'<span class="text-slate-300">—</span>';
        const pay=r.payment?`<span class="px-1.5 py-0.5 rounded text-xs ${/cod/i.test(r.payment)?'bg-orange-100 text-orange-700':'bg-emerald-100 text-emerald-700'}">${/cod/i.test(r.payment)?'COD':'Prepaid'}</span>`:'';
        return `<tr>`+
          `<td class="${OPS_TD}">${tb(r.type)}${r.slaDelay?` <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-700" title="${r.slaDelay} days past first EDD">🕒 ${r.slaDelay}d</span>`:''}</td>`+
          `<td class="${OPS_TD}">${ab(r.action)}</td>`+
          `<td class="${OPS_TD} font-semibold">${r.order||'—'}<div class="text-xs text-slate-400 font-normal">${r.awb||''}</div></td>`+
          `<td class="${OPS_TD} font-semibold tabular-nums">${r.value!=null?OPS_INR(r.value):'—'}</td>`+
          `<td class="${OPS_TD}">${pay}</td>`+
          `<td class="${OPS_TD}">${r.courier||'—'}<div class="text-xs text-slate-400">Zone ${r.zone||'—'}</div></td>`+
          `<td class="${OPS_TD}">${ph}</td>`+
          `<td class="${OPS_TD} text-slate-400 tabular-nums">${r.rto_at||'—'}</td>`+
        `</tr>`; }).join('');
    const more=list.length>500?`<div class="text-xs text-slate-400 p-3 text-center">Showing first 500 of ${list.length}</div>`:'';
    c.innerHTML=`<table class="w-full"><thead><tr>${Hp('Type')}${Hp('Action')}${H('order','Order')}${H('value','Value',1)}${Hp('Pay')}${H('courier','Courier')}${Hp('Customer')}${H('rto_at','Date')}</tr></thead><tbody>${rows}</tbody></table>${more}`;
}

// ── Prepaid loss/misroute predictor ──
async function opsLoadPrepaidRisk(){
    const k=document.getElementById('ops-pr-kpis'); if(k) k.innerHTML='<div class="text-slate-400 text-sm p-6">Scoring in-transit prepaid orders…</div>';
    const days=document.getElementById('ops-pr-days')?.value||'60';
    try{ const r=await fetch('/api/ops-control/prepaid-risk?days='+days,{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsPr=d; const s=d.summary||{};
        k.innerHTML =
            opsKpi('High-risk prepaid','#e11d48','#fff1f2',DP_ICONS.bolt, s.high||0, 'likely lost/misrouted — redispatch now')+
            opsKpi('At-risk value (high)','#059669','#ecfdf5',DP_ICONS.hash, OPS_INR(s.atRiskValue), 'prepaid value that may never arrive')+
            opsKpi('Prepaid in transit','#4f46e5','#eef2ff',DP_ICONS.refresh, s.prepaidInTransit||0, `${s.flagged||0} flagged medium+high`);
        opsPrTable();
    }catch(e){ if(k) k.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
// Prepaid-risk click-to-expand: risk breakdown + timeline + scan log (reuses the DP shipment endpoint).
let _opsPrOpen=null; const _opsPrScan={};
function opsPrDetail(r){ const sc=_opsPrScan[r.awb];
    const reasons=(r.reasons||[]).map(x=>`<span class="inline-block px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600 text-xs mr-1 mb-1">${x}</span>`).join('')||'—';
    let tl='<div class="text-slate-400 text-xs">Loading…</div>';
    if(sc&&sc.journey&&sc.journey.ts){ const ts=sc.journey.ts;
        const step=(label,iso,color)=>{ const on=!!iso; return `<div class="flex items-center gap-2 py-0.5 text-xs"><span class="w-2 h-2 rounded-full shrink-0" style="background:${on?color:'#cbd5e1'}"></span><span class="w-28 text-slate-500">${label}</span><span class="tabular-nums ${on?'text-slate-700 font-medium':'text-slate-300'}">${dpFmtTs(iso)}</span></div>`; };
        tl=step('Order placed',ts.order,'#6366f1')+step('Picked up',ts.dispatched,'#0ea5e9')+step('Out for delivery',ts.ofd,'#f59e0b')+step('Promised EDD',ts.edd,'#8b5cf6'); }
    let scanHtml;
    if(!sc||sc.loading) scanHtml='<div class="text-slate-400 text-xs py-3">Loading scan log…</div>';
    else if(sc.error) scanHtml=`<div class="text-rose-400 text-xs py-3">Couldn’t load: ${sc.error}</div>`;
    else if(!sc.scans||!sc.scans.length) scanHtml='<div class="text-slate-400 text-xs py-3">No scan log available.</div>';
    else scanHtml=`<div class="space-y-1 max-h-56 overflow-auto pr-1">${sc.scans.map(s=>`<div class="flex gap-2 text-xs"><span class="w-28 shrink-0 text-slate-400 tabular-nums">${dpFmtTs(s.at)}</span><span class="text-slate-700">${s.desc}${s.code?` <span class="text-slate-400">(${s.code})</span>`:''}${s.location?` <span class="text-slate-400">· ${s.location}</span>`:''}</span></div>`).join('')}</div>`+(sc.live?'<div class="text-[10px] text-emerald-500 mt-1">● fetched live from courier</div>':'');
    return `<tr class="ops-pr-detail"><td colspan="7" class="px-6 py-4 bg-slate-50 border-b border-slate-200">
        <div class="grid md:grid-cols-3 gap-6">
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Risk ${r.risk}% · ${r.band}</div>
            <div class="mb-2">${reasons}</div>
            <div class="text-xs text-slate-500">📍 Destination: <b class="text-slate-700">${[r.dest_city,r.dest_state].filter(Boolean).join(', ')||'—'}${r.dest_pincode?` · ${r.dest_pincode}`:''}</b></div>
            <div class="text-xs text-slate-500 mt-1">Value: <b class="text-slate-700">${r.value!=null?OPS_INR(r.value):'—'}</b> · Zone <b class="text-slate-700">${r.zone||'—'}</b> · ${r.courier||'—'}</div>
            ${r.phone?`<div class="text-xs text-slate-500 mt-1">📞 <a href="tel:${r.phone}" class="text-indigo-600 hover:underline">${r.phone}</a></div>`:''}</div>
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Timeline</div>${tl}</div>
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Scan log</div>${scanHtml}</div>
        </div></td></tr>`;
}
async function opsPrLoadScans(awb){ _opsPrScan[awb]={loading:true}; try{
        const r=await fetch(`/api/delivery-performance/shipment/${encodeURIComponent(awb)}`,{headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _opsPrScan[awb]={loading:false,scans:d.scans||[],live:!!d.live,journey:d.journey||null};
    }catch(e){ _opsPrScan[awb]={loading:false,error:e.message}; }
    if(_opsPrOpen===awb) opsPrTable();
}
function opsPrTable(){ const c=document.getElementById('ops-pr-table'); const d=_opsPr; if(!d||!c) return;
    const q=(document.getElementById('ops-pr-search')?.value||'').trim().toLowerCase();
    const fB=document.getElementById('ops-prf-band')?.value||'all';
    let list=(d.list||[]).slice();
    if(fB!=='all') list=list.filter(r=>r.band===fB);
    if(q) list=list.filter(r=>(r.order||'').toLowerCase().includes(q)||(r.courier||'').toLowerCase().includes(q));
    list=opsSortBy(list,_opsSortPr);
    const cnt=document.getElementById('ops-pr-count'); if(cnt) cnt.textContent=`${list.length} · ${OPS_INR(list.reduce((s,r)=>s+(r.value||0),0))}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-10 text-center">No at-risk prepaid orders 🎉</div>'; return; }
    const H=(k,lbl,r)=>`<th data-k="${k}" class="${OPS_TH} bg-slate-50 ${r?'text-right':''}">${lbl}${opsArrow(_opsSortPr,k)}</th>`;
    const Hp=lbl=>`<th class="${OPS_TH} bg-slate-50">${lbl}</th>`;
    const rows=list.slice(0,500).map(r=>{
        const bar=r.band==='High'?'bg-red-500':'bg-amber-500', badge=r.band==='High'?'bg-red-100 text-red-700':'bg-amber-100 text-amber-700';
        const ph=r.phone?`<a href="tel:${r.phone}" class="text-indigo-600 hover:underline">${r.phone}</a>`:'<span class="text-slate-300">—</span>';
        const open=r.awb===_opsPrOpen;
        let out=`<tr class="ops-pr-row cursor-pointer ${open?'bg-indigo-50/60':''}" data-awb="${r.awb||''}">`+
          `<td class="${OPS_TD}"><div class="flex items-center gap-2"><span class="inline-flex px-2 py-0.5 rounded-md text-xs font-bold ${badge} tabular-nums">${r.risk}%</span><div class="w-14 h-1.5 bg-slate-100 rounded overflow-hidden"><div class="${bar} h-1.5" style="width:${r.risk}%"></div></div></div></td>`+
          `<td class="${OPS_TD} font-semibold"><span class="text-slate-300 text-xs mr-1">${open?'▾':'▸'}</span>${r.order||'—'}<div class="text-xs text-slate-400 font-normal ml-4">${r.awb||''}</div></td>`+
          `<td class="${OPS_TD} font-semibold tabular-nums">${r.value!=null?OPS_INR(r.value):'—'}</td>`+
          `<td class="${OPS_TD}">${r.courier||'—'}<div class="text-xs text-slate-400">Zone ${r.zone||'—'}</div></td>`+
          `<td class="${OPS_TD} text-right tabular-nums">${r.daysInTransit!=null?r.daysInTransit+'d':'—'}</td>`+
          `<td class="${OPS_TD}">${ph}</td>`+
          `<td class="${OPS_TD} text-slate-500 text-xs">${(r.reasons||[]).join(' · ')||'—'}</td>`+
        `</tr>`;
        if(open) out+=opsPrDetail(r);
        return out; }).join('');
    const more=list.length>500?`<div class="text-xs text-slate-400 p-3 text-center">Showing first 500 of ${list.length}</div>`:'';
    c.innerHTML=`<table class="w-full"><thead><tr>${H('risk','Risk')}${H('order','Order')}${H('value','Value',1)}${H('courier','Courier')}${H('daysInTransit','In transit',1)}${Hp('Customer')}${Hp('Why')}</tr></thead><tbody>${rows}</tbody></table>${more}`;
    c.querySelectorAll('.ops-pr-row').forEach(row=>row.addEventListener('click',e=>{ if(e.target.closest('a')) return;   // let phone links work
        const awb=row.dataset.awb; if(!awb) return;
        _opsPrOpen=(_opsPrOpen===awb)?null:awb; opsPrTable();
        if(_opsPrOpen && !_opsPrScan[awb]) opsPrLoadScans(awb); }));
}

// ─── DocPharma Reconciliation ────────────────────────────────────────────────
let _dpreFrom=null,_dpreTo=null,_dpreData=null,_dpreWired=false,_dpreStatus=[],_dprePayment='all',_dpreSort={k:'orderDate',d:'desc'},_dpreOpen=null,_dpreDFrom='',_dpreDTo='',_dpreCustomer='',_dpreTab='recon'; const _dpreScan={};
// DocPharma workspace tab switcher (Reconciliation / Ledger / Invoices / Payments / Inventory Match)
function dpreTab(name){
    const v=document.getElementById('docpharma-recon-view'); if(!v) return;
    _dpreTab=name;
    v.querySelectorAll('.dpre-tabsec').forEach(s=>s.classList.toggle('hidden', s.id!=='dpre-tab-'+name));
    v.querySelectorAll('.dpre-tab').forEach(b=>{ const on=b.dataset.tab===name;
        b.classList.toggle('border-indigo-500',on); b.classList.toggle('text-indigo-600',on);
        b.classList.toggle('border-transparent',!on); b.classList.toggle('text-slate-500',!on); });
    if(name==='overview') dpreOverviewInit();
    if(name==='recon' && !_dpreData) dpreLoad();
    if(name==='invoices') dpreInvInit();
    if(name==='ledger') dpreLedgerInit();
    if(name==='payments') dprePayInit();
}
const DPRE_STATUS={delivered:['Delivered','bg-emerald-100 text-emerald-700'],rto:['RTO','bg-red-100 text-red-700'],lost:['Lost','bg-rose-100 text-rose-800'],rejected:['Rejected','bg-slate-100 text-slate-500'],cancelled:['Cancelled','bg-slate-100 text-slate-500'],shipped:['Shipped','bg-sky-100 text-sky-700']};
const DPRE_STATUS_OPTS=[['delivered','Delivered'],['rto','RTO'],['lost','Lost'],['rejected','Rejected'],['cancelled','Cancelled'],['shipped','Shipped']];
// 'YYYY-MM-DD' → 'DD-MM-YYYY'
function dpreDMY(s){ if(!s)return ''; const p=String(s).slice(0,10).split('-'); return p.length===3?`${p[2]}-${p[1]}-${p[0]}`:s; }
function dpreBucket(o){ const s=(o.order_status||o.outcome||'').toLowerCase(); return s||'other'; }
function dpreInit(){
    const v=document.getElementById('docpharma-recon-view'); if(!v) return;
    if(!_dpreWired){
        const t=new Date(), f=new Date(t.getFullYear(),t.getMonth(),t.getDate()-30);
        const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        _dpreFrom=fmt(f); _dpreTo=fmt(t);
        v.innerHTML=`
        <div class="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-slate-200 px-6 pt-4">
          <h1 class="text-2xl font-bold text-slate-800">DocPharma</h1>
          <nav class="flex gap-1 mt-3 -mb-px overflow-x-auto">
            ${[['overview','Overview'],['recon','Reconciliation'],['ledger','Ledger'],['invoices','Invoices'],['payments','Payments'],['inventory','Inventory Match']].map(([k,l])=>`<button class="dpre-tab px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700 whitespace-nowrap" data-tab="${k}">${l}</button>`).join('')}
          </nav>
        </div>

        <section id="dpre-tab-overview" class="dpre-tabsec"></section>

        <section id="dpre-tab-recon" class="dpre-tabsec hidden">
        <header class="px-6 py-4 border-b border-slate-200">
          <div class="flex items-start justify-between flex-wrap gap-3">
            <p class="text-sm text-slate-400" id="dpre-sub">Expected DocPharma charges from delivery status &amp; your rate card</p>
            <div class="flex items-center gap-2">
              <span id="dpre-ratebadge" class="text-xs text-slate-500 px-3 py-1.5 bg-white border border-slate-200 rounded-lg"></span>
              <button id="dpre-settings-btn" class="text-sm px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400">⚙ Rate Card</button>
              <button id="dpre-import-btn" class="text-sm px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400" title="Upload DocPharma's order export (CSV) to backfill history">📤 Import CSV</button>
              <input type="file" id="dpre-import-file" accept=".csv,.tsv,.txt" class="hidden">
              <button id="dpre-snapshot-btn" class="text-sm px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400" title="Freeze current charges into the log">🧾 Log snapshot</button>
              <button id="dpre-refresh" class="text-sm px-3 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700">↻ Refresh</button>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap mt-3">
            <input type="date" id="dpre-from" value="${_dpreFrom}" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700">
            <span class="text-slate-400">→</span>
            <input type="date" id="dpre-to" value="${_dpreTo}" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700">
            <button id="dpre-apply" class="text-sm px-4 py-2 bg-slate-800 text-white rounded-lg">Apply</button>
            <div id="dpre-status-multi" class="dpre-multi"><button type="button" class="dpre-multi-btn"><span class="text-slate-400">All status</span> <span class="text-slate-400">▾</span></button><div class="dpre-multi-panel hidden"></div></div>
            <select id="dpre-payment" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700">
              <option value="all">All payment</option><option value="cod">COD</option><option value="prepaid">Prepaid</option></select>
            <input type="text" id="dpre-customer" placeholder="Customer name" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700 min-w-[150px]">
            <input type="text" id="dpre-search" placeholder="Search order / AWB / courier" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700 flex-1 min-w-[160px]">
          </div>
          <div class="flex items-center gap-2 flex-wrap mt-2">
            <span class="text-xs text-slate-400 font-medium">Delivered / RTO</span>
            <input type="date" id="dpre-dfrom" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700">
            <span class="text-slate-400">→</span>
            <input type="date" id="dpre-dto" class="text-sm px-3 py-2 border border-slate-200 rounded-lg bg-white text-slate-700">
            <button id="dpre-dclear" class="text-xs px-2.5 py-2 text-slate-500 hover:text-slate-700">clear</button>
          </div>
        </header>
        <div class="p-6 space-y-5">
          <div id="dpre-kpis" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"></div>
          <div class="card p-5"><h2 class="text-sm font-bold text-slate-700 mb-3">Expected charge breakdown</h2><div id="dpre-breakdown"></div></div>
          <div class="card p-0 overflow-hidden">
            <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100"><h2 class="text-sm font-bold text-slate-700">Orders</h2><span id="dpre-count" class="text-xs text-slate-400"></span></div>
            <div id="dpre-table" class="overflow-x-auto"></div>
          </div>
        </div>
        </section>

        <section id="dpre-tab-ledger" class="dpre-tabsec hidden"><div class="p-6"><div class="card p-10 text-center text-slate-400">Ledger — coming in Phase 3 · Receivable / Payable / Net / Outstanding</div></div></section>
        <section id="dpre-tab-invoices" class="dpre-tabsec hidden"><div class="p-6"><div class="card p-10 text-center text-slate-400">Invoices — coming in Phase 2 · goods-out invoices + DocPharma charge invoices</div></div></section>
        <section id="dpre-tab-payments" class="dpre-tabsec hidden"><div class="p-6"><div class="card p-10 text-center text-slate-400">Payments — coming in Phase 3 · remittances received from DocPharma</div></div></section>
        <section id="dpre-tab-inventory" class="dpre-tabsec hidden"><div class="p-6"><div class="card p-10 text-center text-slate-400">Inventory / SKU Match — coming in Phase 4 · goods sent vs delivered/RTO/lost</div></div></section>

        <!-- Rate card modal -->
        <div id="dpre-settings" class="fixed inset-0 z-50 hidden items-center justify-center" style="background:rgba(15,23,42,.4)">
          <div class="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onclick="event.stopPropagation()">
            <h3 class="text-lg font-bold text-slate-800 mb-1">DocPharma Rate Card</h3>
            <p class="text-xs text-slate-400 mb-4">Applies to new reconciliations. Past snapshots keep their original rates.</p>
            <label class="block text-sm text-slate-600 mb-1">Flat Service Charge (₹ per delivered order)</label>
            <input type="number" id="dpre-rc-service" class="w-full mb-3 px-3 py-2 border border-slate-200 rounded-lg" min="0" step="0.01">
            <label class="block text-sm text-slate-600 mb-1">RTO Charge (₹ per RTO order)</label>
            <input type="number" id="dpre-rc-rto" class="w-full mb-3 px-3 py-2 border border-slate-200 rounded-lg" min="0" step="0.01">
            <label class="block text-sm text-slate-600 mb-1">COD Collection Charge (₹ per delivered COD order)</label>
            <input type="number" id="dpre-rc-cod" class="w-full mb-4 px-3 py-2 border border-slate-200 rounded-lg" min="0" step="0.01">
            <div class="flex justify-end gap-2"><button id="dpre-rc-cancel" class="px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button id="dpre-rc-save" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg">Save rate card</button></div>
          </div>
        </div>`;
        v.querySelectorAll('.dpre-tab').forEach(btn=>btn.addEventListener('click',()=>dpreTab(btn.dataset.tab)));
        v.querySelector('#dpre-apply').addEventListener('click',()=>{ _dpreFrom=v.querySelector('#dpre-from').value; _dpreTo=v.querySelector('#dpre-to').value; dpreLoad(); });
        v.querySelector('#dpre-refresh').addEventListener('click',()=>dpreLoad());
        dpreBuildStatusPanel();
        v.querySelector('#dpre-payment').addEventListener('change',e=>{ _dprePayment=e.target.value; dpreLoad(); });
        v.querySelector('#dpre-search').addEventListener('input',()=>dpreTable());
        v.querySelector('#dpre-dfrom').addEventListener('change',e=>{ _dpreDFrom=e.target.value; dpreLoad(); });
        v.querySelector('#dpre-dto').addEventListener('change',e=>{ _dpreDTo=e.target.value; dpreLoad(); });
        v.querySelector('#dpre-dclear').addEventListener('click',()=>{ _dpreDFrom=''; _dpreDTo=''; v.querySelector('#dpre-dfrom').value=''; v.querySelector('#dpre-dto').value=''; dpreLoad(); });
        { let ct; v.querySelector('#dpre-customer').addEventListener('input',e=>{ clearTimeout(ct); const val=e.target.value; ct=setTimeout(()=>{ _dpreCustomer=val; dpreLoad(); },350); }); }
        v.querySelector('#dpre-settings-btn').addEventListener('click',()=>dpreOpenSettings());
        v.querySelector('#dpre-settings').addEventListener('click',()=>dpreCloseSettings());
        v.querySelector('#dpre-rc-cancel').addEventListener('click',()=>dpreCloseSettings());
        v.querySelector('#dpre-rc-save').addEventListener('click',()=>dpreSaveSettings());
        v.querySelector('#dpre-snapshot-btn').addEventListener('click',()=>dpreSnapshot());
        v.querySelector('#dpre-import-btn').addEventListener('click',()=>v.querySelector('#dpre-import-file').click());
        v.querySelector('#dpre-import-file').addEventListener('change',e=>{ const f=e.target.files&&e.target.files[0]; if(f) dpreImport(f); });
        _dpreWired=true;
        dpreTab('overview');
        return;                                    // landing tab loads itself
    }
    // subsequent entries → refresh the active tab
    if(_dpreTab==='overview') dpreOverviewLoad();
    else if(_dpreTab==='ledger') dpreLedgerLoad();
    else dpreLoad();
}
function dpreBuildStatusPanel(){
    const wrap=document.getElementById('dpre-status-multi'); if(!wrap) return;
    const btn=wrap.querySelector('.dpre-multi-btn'), panel=wrap.querySelector('.dpre-multi-panel');
    panel.innerHTML=`<div class="dpre-multi-actions"><button type="button" class="dpre-multi-all">Select all</button><button type="button" class="dpre-multi-clear">Clear all</button></div>`+
        DPRE_STATUS_OPTS.map(([v,l])=>`<label class="dpre-multi-item"><input type="checkbox" value="${v}"><span>${l}</span></label>`).join('');
    const sync=()=>{ panel.querySelectorAll('input[type=checkbox]').forEach(cb=>{ cb.checked=_dpreStatus.includes(cb.value); });
        btn.innerHTML=(_dpreStatus.length===0?'<span class="text-slate-400">All status</span>':_dpreStatus.length===1?((DPRE_STATUS[_dpreStatus[0]]||[_dpreStatus[0]])[0]):`Status: ${_dpreStatus.length}`)+' <span class="text-slate-400">▾</span>'; };
    panel.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
        if(cb.checked){ if(!_dpreStatus.includes(cb.value)) _dpreStatus.push(cb.value); } else _dpreStatus=_dpreStatus.filter(x=>x!==cb.value);
        sync(); dpreLoad(); }));
    panel.querySelector('.dpre-multi-all').addEventListener('click',()=>{ _dpreStatus=DPRE_STATUS_OPTS.map(o=>o[0]); sync(); dpreLoad(); });
    panel.querySelector('.dpre-multi-clear').addEventListener('click',()=>{ _dpreStatus=[]; sync(); dpreLoad(); });
    btn.addEventListener('click',e=>{ e.stopPropagation(); panel.classList.toggle('hidden'); });
    document.addEventListener('click',e=>{ if(!wrap.contains(e.target)) panel.classList.add('hidden'); });
    sync();
}
async function dpreLoad(){
    const k=document.getElementById('dpre-kpis'); if(k) k.innerHTML=ecSkelCards(6);
    const tbl=document.getElementById('dpre-table'); if(tbl) tbl.innerHTML='<div class="p-4 space-y-2">'+Array.from({length:6}).map(()=>'<div class="skl" style="height:34px;width:100%"></div>').join('')+'</div>';
    try{
        const r=await fetch(`/api/docpharma-recon?from=${_dpreFrom}&to=${_dpreTo}&status=${encodeURIComponent(_dpreStatus.join(','))}&payment=${_dprePayment}&dfrom=${_dpreDFrom}&dto=${_dpreDTo}&customer=${encodeURIComponent(_dpreCustomer)}`,{headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _dpreData=d; dpreRender(d); ecFade('dpre-kpis','dpre-table');
    }catch(e){ if(k) k.innerHTML='<div class="col-span-6 text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
function dpreRender(d){
    const rc=d.rateCard||{}, k=d.kpis||{};
    const rb=document.getElementById('dpre-ratebadge'); if(rb) rb.innerHTML=`Service ₹${rc.flat_service_charge} · RTO ₹${rc.rto_charge} · COD ₹${rc.cod_collection_charge}`;
    const card=(label,val,sub,accent)=>`<div class="card p-4 lift"><div class="text-xs text-slate-400 uppercase tracking-wide">${label}</div><div class="text-2xl font-bold ${accent||'text-slate-800'} tabular-nums mt-1">${val}</div><div class="text-xs text-slate-400 mt-0.5">${sub||''}</div></div>`;
    document.getElementById('dpre-kpis').innerHTML=
        card('DocPharma orders',k.orders,`${k.codOrders} COD · excl. rejected/cancelled`)+
        card('Delivered',k.delivered,'billable','text-emerald-600')+
        card('RTO',k.rto,'RTO charge','text-red-600')+
        card('Rejected / Cancelled',(k.rejected||0)+(k.cancelled||0),'not billed','text-slate-500')+
        card('Total charges',OPS_INR(k.totalWithGst),'incl 18% GST','text-indigo-600')+
        card('Delivered GMV',OPS_INR(k.gmvDelivered),'order value','text-slate-600');
    const seg=[['Flat Service',k.serviceTotal,'#6366f1'],['RTO',k.rtoTotal,'#ef4444'],['COD Collection',k.codTotal,'#0ea5e9']];
    const tot=Math.max(1,seg.reduce((s,x)=>s+x[1],0));
    document.getElementById('dpre-breakdown').innerHTML=
        `<div class="flex h-3 rounded overflow-hidden mb-3">${seg.map(x=>`<div style="width:${x[1]/tot*100}%;background:${x[2]}"></div>`).join('')}</div>`+
        `<div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">${seg.map(x=>`<span class="text-slate-600"><span class="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style="background:${x[2]}"></span>${x[0]}: <b class="tabular-nums">${OPS_INR(x[1])}</b></span>`).join('')}<span class="ml-auto text-slate-500">Subtotal ${OPS_INR(k.confirmedTotal)} · GST 18% ${OPS_INR(k.gst)} · <b class="text-slate-800">Total ${OPS_INR(k.totalWithGst)}</b></span></div>`;
    dpreTable();
}
function dpreSortVal(o,k){ switch(k){ case'value':return o.value||0; case'total':return o.total||0; case'service':return o.service||0; case'rto':return o.rto||0; case'cod':return o.cod||0; case'order':return(o.order||'').toLowerCase(); case'status':return dpreBucket(o); case'payment':return o.isCOD?'cod':'prepaid'; case'orderDate':return o.orderDate||''; case'closeDate':return o.closeDate||''; default:return''; } }
function dpreTable(){ const c=document.getElementById('dpre-table'); const d=_dpreData; if(!d||!c) return;
    const q=(document.getElementById('dpre-search')?.value||'').trim().toLowerCase();
    let list=(d.orders||[]).slice();
    if(q) list=list.filter(o=>(o.order||'').toLowerCase().includes(q)||(o.awb||'').toLowerCase().includes(q)||(o.courier||'').toLowerCase().includes(q));
    const dir=_dpreSort.d==='asc'?1:-1;
    list=list.sort((a,b)=>{const va=dpreSortVal(a,_dpreSort.k),vb=dpreSortVal(b,_dpreSort.k);return va<vb?-dir:va>vb?dir:0;});
    const cnt=document.getElementById('dpre-count'); if(cnt) cnt.textContent=`${list.length} orders · ${OPS_INR(list.reduce((s,o)=>s+(o.total||0),0))} confirmed${d.truncated?` · capped at ${d.orders.length} of ${d.total}`:''}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-8 text-center">No DocPharma orders in this window</div>'; return; }
    const th='px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap bg-slate-50/60';
    const td='px-3 py-2.5 text-sm text-slate-700 border-b border-slate-100 align-middle whitespace-nowrap';
    const cols=[{k:'order',l:'Order / AWB'},{k:'orderDate',l:'Ordered'},{k:'value',l:'Value',a:1},{k:'payment',l:'Pay'},{k:'status',l:'Status'},{k:'closeDate',l:'Delivered / RTO'},{k:'service',l:'Service',a:1},{k:'rto',l:'RTO',a:1},{k:'cod',l:'COD',a:1},{k:'total',l:'Total',a:1}];
    const closeDateStr=o=>o.closeDate||'';
    const head=cols.map(col=>{const al=col.a?' text-right':'';const act=_dpreSort.k===col.k;const ar=act?`<span class="text-indigo-500">${_dpreSort.d==='asc'?'↑':'↓'}</span>`:'<span class="text-slate-300">↕</span>';return `<th class="${th}${al} dpre-sort cursor-pointer select-none ${act?'text-slate-600':''}" data-k="${col.k}">${col.l} ${ar}</th>`;}).join('');
    const rows=list.slice(0,600).map(o=>{ const bk=dpreBucket(o), sb=DPRE_STATUS[bk]||['—','bg-slate-100 text-slate-600'], open=!!_dpreOpen&&(o.awb===_dpreOpen||('#'+o.order)===_dpreOpen||o.order===_dpreOpen);
        const key=o.awb||o.order;
        const money=v=>v?`<span class="tabular-nums">${OPS_INR(v)}</span>`:'<span class="text-slate-300">—</span>';
        let out=`<tr class="dpre-row cursor-pointer ${open?'bg-indigo-50/60':'hover:bg-slate-50'}" data-key="${key}" data-order="${o.order}">`+
          `<td class="${td} font-semibold"><span class="text-slate-300 text-xs mr-1">${open?'▾':'▸'}</span>${o.order||'—'}<div class="text-[11px] text-slate-400 font-normal ml-4">${o.awb||''}</div></td>`+
          `<td class="${td} text-slate-500 tabular-nums">${o.orderDate?dpreDMY(o.orderDate):'—'}</td>`+
          `<td class="${td} text-right tabular-nums">${o.value!=null?OPS_INR(o.value):'—'}</td>`+
          `<td class="${td}"><span class="px-1.5 py-0.5 rounded text-[11px] font-medium ${o.isCOD?'bg-orange-100 text-orange-700':'bg-emerald-100 text-emerald-700'}">${o.isCOD?'COD':'Prepaid'}</span></td>`+
          `<td class="${td}"><span class="px-2 py-0.5 rounded-full text-[11px] font-medium ${sb[1]}">${sb[0]}</span></td>`+
          `<td class="${td} text-slate-500 tabular-nums">${closeDateStr(o)?dpreDMY(closeDateStr(o)):'<span class="text-slate-300">—</span>'}</td>`+
          `<td class="${td} text-right">${money(o.service)}</td>`+
          `<td class="${td} text-right">${money(o.rto)}</td>`+
          `<td class="${td} text-right">${money(o.cod)}</td>`+
          `<td class="${td} text-right font-bold">${o.total?`<span class="tabular-nums text-slate-800">${OPS_INR(o.total)}</span>`:'<span class="text-slate-300">—</span>'}</td>`+
        `</tr>`;
        if(open) out+=dpreDetail(o);
        return out; }).join('');
    const more=list.length>600?`<div class="text-xs text-slate-400 p-3 text-center border-t border-slate-100">Showing first 600 of ${list.length}</div>`:'';
    c.innerHTML=`<table class="w-full border-collapse"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${more}`;
    c.querySelectorAll('.dpre-sort').forEach(h=>h.addEventListener('click',()=>{const k=h.dataset.k; if(_dpreSort.k===k)_dpreSort.d=_dpreSort.d==='asc'?'desc':'asc'; else _dpreSort={k,d:['value','total','service','rto','cod','orderDate'].includes(k)?'desc':'asc'}; dpreTable();}));
    c.querySelectorAll('.dpre-row').forEach(row=>row.addEventListener('click',e=>{ if(e.target.closest('a')||e.target.closest('button'))return; const key=row.dataset.key; if(!key)return;
        _dpreOpen=(_dpreOpen===key)?null:key; dpreTable(); }));
}
function dpreDetail(o){
    const dest=[o.dest_city,o.dest_state].filter(Boolean).join(', ')||'—';
    const step=(label,iso,color)=>{const on=!!iso;return `<div class="flex items-center gap-2 py-0.5 text-xs"><span class="w-2 h-2 rounded-full shrink-0" style="background:${on?color:'#cbd5e1'}"></span><span class="w-24 text-slate-500">${label}</span><span class="tabular-nums ${on?'text-slate-700 font-medium':'text-slate-300'}">${dpFmtTs(iso)}</span></div>`;};
    const ts=o.ts||{}, bk=dpreBucket(o);
    const tl=step('Order placed',ts.order,'#6366f1')+step('Dispatched',ts.dispatched,'#0ea5e9')+(bk==='rto'?step('RTO',ts.rto,'#ef4444'):bk==='delivered'?step('Delivered',ts.delivered,'#16a34a'):bk==='lost'?step('Lost',ts.last,'#e11d48'):step('Last update',ts.last,'#94a3b8'))+step('Promised EDD',ts.edd,'#8b5cf6');
    const trackLink=o.tracking_url?`<a href="${o.tracking_url}" target="_blank" rel="noopener" class="text-indigo-600 hover:underline">Track ↗</a>`:'';
    const pretty=l=>String(l||'').split('_').map(w=>/^(rto|ofd|edd)$/i.test(w)?w.toUpperCase():w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
    const dot=l=>/rto_delivered|^delivered$/.test(l)?'#16a34a':/rto/.test(l)?'#ef4444':/out_for_delivery|ofd/.test(l)?'#f59e0b':/picked_up|manifest|in_transit|reached|dispatch/.test(l)?'#0ea5e9':'#94a3b8';
    const scans=Array.isArray(o.scans)?o.scans:[];
    const scanHtml=scans.length
      ? `<div class="space-y-1.5 max-h-64 overflow-auto pr-1">${scans.map(s=>`<div class="flex gap-2 text-xs"><span class="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style="background:${dot(s.label)}"></span><span class="w-28 shrink-0 text-slate-400 tabular-nums">${dpFmtTs(s.at)}</span><span class="text-slate-700">${pretty(s.label)}${s.location?` <span class="text-slate-400">· ${s.location}</span>`:''}${s.reason?` <span class="text-slate-400">· ${s.reason}</span>`:''}</span></div>`).join('')}</div>`
      : `<div class="text-slate-400 text-xs py-2">No scan timeline synced yet.</div>`;
    const items=Array.isArray(o.items)?o.items:[];
    const itemsHtml=items.length?`<div class="mt-2 pt-2 border-t border-slate-200"><div class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">Items (${items.length})</div>${items.map(it=>`<div class="text-xs text-slate-500 leading-snug">${it.qty}× <b class="text-slate-700">${it.sku||'—'}</b>${it.name?` <span class="text-slate-400">${it.name}${it.variant?' · '+it.variant:''}</span>`:''}</div>`).join('')}</div>`:'';
    return `<tr class="dpre-detail"><td colspan="10" class="px-6 py-4 bg-slate-50 border-b border-slate-200">
        <div class="grid md:grid-cols-3 gap-6">
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Charge</div>
            <div class="text-xs text-slate-500">Service <b class="text-slate-700">${OPS_INR(o.service)}</b> · RTO <b class="text-slate-700">${OPS_INR(o.rto)}</b> · COD <b class="text-slate-700">${OPS_INR(o.cod)}</b></div>
            <div class="text-sm text-slate-800 font-bold mt-1">Total ${OPS_INR(o.total)}</div>
            <div class="text-xs text-slate-500 mt-2">📍 ${dest}${o.dest_pincode?` · ${o.dest_pincode}`:''}</div>
            <div class="text-xs text-slate-500">Value <b class="text-slate-700">${o.value!=null?OPS_INR(o.value):'—'}</b> · ${o.customer||'—'}</div>
            <div class="text-xs text-slate-500 mt-1">AWB <b class="text-slate-700">${o.awb||'—'}</b> ${trackLink}</div>
            ${o.reason?`<div class="text-xs text-slate-500 mt-1">Reason: <span class="text-slate-700">${o.reason}</span></div>`:''}
            ${o.phone?`<div class="text-xs text-slate-500 mt-1">📞 <a href="tel:${o.phone}" class="text-indigo-600 hover:underline">${o.phone}</a></div>`:''}
            ${itemsHtml}</div>
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Timeline</div>${tl}</div>
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Scan log ${scans.length?`<span class="text-slate-400 font-normal">(${scans.length})</span>`:''}</div>${scanHtml}</div>
        </div></td></tr>`;
}
async function dpreLoadScans(awb){ _dpreScan[awb]={loading:true}; try{
        const r=await fetch(`/api/delivery-performance/shipment/${encodeURIComponent(awb)}`,{headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _dpreScan[awb]={loading:false,scans:d.scans||[]};
    }catch(e){ _dpreScan[awb]={loading:false,error:e.message}; }
    if(_dpreOpen===awb) dpreTable();
}
async function dpreFetchStatus(order,btn){ if(btn){ btn.disabled=true; btn.textContent='Fetching…'; }
    try{ const r=await fetch(`/api/docpharma-recon/fetch/${encodeURIComponent(order)}`,{method:'POST',headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'not found');
        showNotification(`${order} → ${d.status||d.outcome||'updated'}`); dpreLoad();
    }catch(e){ showNotification('Fetch failed: '+e.message,true); if(btn){ btn.disabled=false; btn.textContent='↻ Fetch DocPharma status'; } }
}
document.addEventListener('click',e=>{ const b=e.target.closest('.dpre-fetch'); if(b){ e.stopPropagation(); dpreFetchStatus(b.dataset.order,b); } });
function dpreOpenSettings(){ const rc=(_dpreData&&_dpreData.rateCard)||{}; const m=document.getElementById('dpre-settings');
    document.getElementById('dpre-rc-service').value=rc.flat_service_charge??0;
    document.getElementById('dpre-rc-rto').value=rc.rto_charge??0;
    document.getElementById('dpre-rc-cod').value=rc.cod_collection_charge??0;
    m.classList.remove('hidden'); m.classList.add('flex'); }
function dpreCloseSettings(){ const m=document.getElementById('dpre-settings'); m.classList.add('hidden'); m.classList.remove('flex'); }
async function dpreSaveSettings(){
    const body={ flat_service_charge:parseFloat(document.getElementById('dpre-rc-service').value)||0,
        rto_charge:parseFloat(document.getElementById('dpre-rc-rto').value)||0,
        cod_collection_charge:parseFloat(document.getElementById('dpre-rc-cod').value)||0, updated_by:'dashboard' };
    try{ const r=await fetch('/api/docpharma-recon/settings',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify(body)});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        dpreCloseSettings(); showNotification('Rate card saved'); dpreLoad();
    }catch(e){ showNotification('Save failed: '+e.message,true); }
}
async function dpreSnapshot(){ const d=_dpreData; if(!d||!d.orders||!d.orders.length){ showNotification('Nothing to snapshot',true); return; }
    try{ const r=await fetch('/api/docpharma-recon/snapshot',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify({orders:d.orders})});
        const j=await r.json(); if(!j.success) throw new Error(j.error||'failed');
        showNotification(`Logged snapshot of ${j.logged} orders`);
    }catch(e){ showNotification('Snapshot failed: '+e.message,true); }
}
async function dpreImport(file){
    const btn=document.getElementById('dpre-import-btn'); const label=btn?btn.textContent:''; if(btn){ btn.disabled=true; btn.textContent='Uploading…'; }
    try{
        const text=await file.text();
        const r=await fetch('/api/docpharma-recon/import',{method:'POST',headers:{...getAuthHeaders(),'Content-Type':'text/plain; charset=utf-8'},body:text});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'import failed');
        const dist=Object.entries(d.statusDist||{}).map(([k,v])=>`${k}: ${v}`).join(' · ');
        showNotification(`Imported ${d.imported} DocPharma orders${dist?' ('+dist+')':''}`);
        dpreLoad();
    }catch(e){ showNotification('Import failed: '+e.message,true); }
    finally{ if(btn){ btn.disabled=false; btn.textContent=label; } const f=document.getElementById('dpre-import-file'); if(f) f.value=''; }
}

// ─── DocPharma Ledger — Invoices tab ─────────────────────────────────────────
let _dpreInvWired=false, _dpinvForm={items:[]};
const DPINV_IN='border border-slate-200 rounded px-2 py-1 text-xs focus:border-indigo-400 outline-none';
function dpreInvInit(){
    const sec=document.getElementById('dpre-tab-invoices'); if(!sec) return;
    if(!_dpreInvWired){
        sec.innerHTML=`<div class="p-6 space-y-6">
          <div class="card p-0 overflow-hidden">
            <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <h2 class="text-sm font-bold text-slate-700">Goods-Out Invoices <span class="text-slate-400 font-normal">· you → DocPharma (stock sent)</span></h2>
              <div class="flex gap-2">
                <button id="dpinv-goods-add" class="text-xs px-3 py-1.5 bg-white border border-slate-200 rounded-lg hover:border-indigo-400">＋ Add</button>
                <button id="dpinv-goods-upload" class="text-xs px-3 py-1.5 bg-slate-800 text-white rounded-lg">📤 Upload (Excel/CSV/PDF)</button>
                <input type="file" id="dpinv-goods-file" accept=".pdf,.xlsx,.xls,.csv" class="hidden">
              </div>
            </div>
            <div id="dpinv-goods-list" class="overflow-x-auto"></div>
          </div>
          <div class="card p-0 overflow-hidden">
            <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <h2 class="text-sm font-bold text-slate-700">DocPharma Charge Invoices <span class="text-slate-400 font-normal">· DocPharma → you (service fees)</span></h2>
              <div class="flex gap-2">
                <button id="dpinv-charge-add" class="text-xs px-3 py-1.5 bg-white border border-slate-200 rounded-lg hover:border-indigo-400">＋ Add</button>
                <button id="dpinv-charge-upload" class="text-xs px-3 py-1.5 bg-slate-800 text-white rounded-lg">📤 Upload PDF</button>
                <input type="file" id="dpinv-charge-file" accept=".pdf" class="hidden">
              </div>
            </div>
            <div id="dpinv-charge-list" class="overflow-x-auto"></div>
          </div>
        </div>
        <div id="dpinv-modal" class="fixed inset-0 z-50 hidden items-start justify-center overflow-auto py-8" style="background:rgba(15,23,42,.45)"><div id="dpinv-modal-box" class="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-6 mx-4" onclick="event.stopPropagation()"></div></div>`;
        sec.querySelector('#dpinv-goods-add').addEventListener('click',()=>dpinvGoodsForm());
        sec.querySelector('#dpinv-goods-upload').addEventListener('click',()=>sec.querySelector('#dpinv-goods-file').click());
        sec.querySelector('#dpinv-goods-file').addEventListener('change',e=>{const f=e.target.files[0]; if(f)dpinvUpload('goods',f); e.target.value='';});
        sec.querySelector('#dpinv-charge-add').addEventListener('click',()=>dpinvChargeForm());
        sec.querySelector('#dpinv-charge-upload').addEventListener('click',()=>sec.querySelector('#dpinv-charge-file').click());
        sec.querySelector('#dpinv-charge-file').addEventListener('change',e=>{const f=e.target.files[0]; if(f)dpinvUpload('charge',f); e.target.value='';});
        sec.querySelector('#dpinv-modal').addEventListener('click',()=>dpinvCloseModal());
        _dpreInvWired=true;
    }
    dpinvLoadGoods(); dpinvLoadCharge();
}
function dpinvOpenModal(){ const m=document.getElementById('dpinv-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }
function dpinvCloseModal(){ const m=document.getElementById('dpinv-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }
const _th='px-3 py-2 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60', _td='px-3 py-2 text-sm text-slate-700 border-b border-slate-100';
async function dpinvLoadGoods(){ const el=document.getElementById('dpinv-goods-list'); if(!el)return; el.innerHTML='<div class="p-4 text-xs text-slate-400">Loading…</div>';
    try{ const r=await fetch('/api/docpharma-invoices/goods',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        const invs=d.invoices||[]; if(!invs.length){ el.innerHTML='<div class="p-6 text-center text-xs text-slate-400">No goods invoices yet — Add or Upload one.</div>'; return; }
        el.innerHTML=`<table class="w-full"><thead><tr><th class="${_th}">Invoice</th><th class="${_th}">Date</th><th class="${_th}">PO</th><th class="${_th} text-right">Qty</th><th class="${_th} text-right">Value</th><th class="${_th}"></th></tr></thead><tbody>${invs.map(iv=>`<tr class="hover:bg-slate-50"><td class="${_td} font-semibold">${iv.invoice_no||'—'}</td><td class="${_td} tabular-nums">${dpreDMY(iv.invoice_date)||'—'}</td><td class="${_td}">${iv.po_number||'—'}</td><td class="${_td} text-right tabular-nums">${iv.total_qty||0}</td><td class="${_td} text-right tabular-nums">${OPS_INR(iv.total_value||0)}</td><td class="${_td} text-right whitespace-nowrap"><button class="dpinv-gv text-indigo-600 text-xs" data-id="${iv.id}">View</button> <button class="dpinv-gd text-rose-500 text-xs ml-2" data-id="${iv.id}" data-no="${iv.invoice_no||''}">Delete</button></td></tr>`).join('')}</tbody></table>`;
        el.querySelectorAll('.dpinv-gv').forEach(b=>b.addEventListener('click',()=>dpinvGoodsView(b.dataset.id)));
        el.querySelectorAll('.dpinv-gd').forEach(b=>b.addEventListener('click',()=>dpinvDelete('goods',b.dataset.id,b.dataset.no)));
    }catch(e){ el.innerHTML='<div class="p-4 text-xs text-rose-500">'+e.message+'</div>'; }
}
async function dpinvLoadCharge(){ const el=document.getElementById('dpinv-charge-list'); if(!el)return; el.innerHTML='<div class="p-4 text-xs text-slate-400">Loading…</div>';
    try{ const r=await fetch('/api/docpharma-invoices/charge',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        const invs=d.invoices||[]; if(!invs.length){ el.innerHTML='<div class="p-6 text-center text-xs text-slate-400">No charge invoices yet — Add or Upload one.</div>'; return; }
        el.innerHTML=`<table class="w-full"><thead><tr><th class="${_th}">Invoice</th><th class="${_th}">Date</th><th class="${_th}">Subject</th><th class="${_th} text-right">Service</th><th class="${_th} text-right">RTO</th><th class="${_th} text-right">COD</th><th class="${_th} text-right">Grand Total</th><th class="${_th}"></th></tr></thead><tbody>${invs.map(iv=>`<tr class="hover:bg-slate-50"><td class="${_td} font-semibold">${iv.invoice_no||'—'}</td><td class="${_td} tabular-nums">${dpreDMY(iv.invoice_date)||'—'}</td><td class="${_td} text-slate-500">${iv.subject||'—'}</td><td class="${_td} text-right tabular-nums">${OPS_INR(iv.service_total||0)}</td><td class="${_td} text-right tabular-nums">${OPS_INR(iv.rto_total||0)}</td><td class="${_td} text-right tabular-nums">${OPS_INR(iv.cod_fee_total||0)}</td><td class="${_td} text-right tabular-nums font-bold">${OPS_INR(iv.grand_total||iv.total_charges||0)}</td><td class="${_td} text-right whitespace-nowrap"><button class="dpinv-cv text-indigo-600 text-xs" data-id="${iv.id}">Edit</button> <button class="dpinv-cd text-rose-500 text-xs ml-2" data-id="${iv.id}" data-no="${iv.invoice_no||''}">Delete</button></td></tr>`).join('')}</tbody></table>`;
        el.querySelectorAll('.dpinv-cv').forEach(b=>b.addEventListener('click',()=>dpinvChargeForm(invs.find(x=>String(x.id)===b.dataset.id))));
        el.querySelectorAll('.dpinv-cd').forEach(b=>b.addEventListener('click',()=>dpinvDelete('charge',b.dataset.id,b.dataset.no)));
    }catch(e){ el.innerHTML='<div class="p-4 text-xs text-rose-500">'+e.message+'</div>'; }
}
async function dpinvGoodsView(id){ try{ const r=await fetch('/api/docpharma-invoices/goods/'+id,{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error); dpinvGoodsForm({...d.invoice, items:d.items}); }catch(e){ showNotification(e.message,true); } }
function dpinvField(label,id,val,type){ return `<div><label class="block text-[11px] text-slate-500 mb-0.5">${label}</label><input id="${id}" type="${type||'text'}" value="${val==null?'':String(val).replace(/"/g,'&quot;')}" class="${DPINV_IN} w-full"></div>`; }
function dpinvGoodsRow(it,i){ return `<tr class="border-b border-slate-100"><td class="p-1"><input data-i="${i}" data-f="sku" value="${(it.sku||'').replace(/"/g,'&quot;')}" class="${DPINV_IN} w-24" placeholder="SKU"></td><td class="p-1"><input data-i="${i}" data-f="name" value="${(it.name||'').replace(/"/g,'&quot;')}" class="${DPINV_IN} w-full min-w-[200px]" placeholder="Product name"></td><td class="p-1"><input data-i="${i}" data-f="hsn" value="${it.hsn||''}" class="${DPINV_IN} w-20" placeholder="HSN"></td><td class="p-1"><input data-i="${i}" data-f="qty" value="${it.qty||''}" class="${DPINV_IN} w-16 text-right" placeholder="Qty"></td><td class="p-1"><input data-i="${i}" data-f="rate" value="${it.rate||''}" class="${DPINV_IN} w-20 text-right" placeholder="Rate"></td><td class="p-1"><input data-i="${i}" data-f="amount" value="${it.amount||''}" class="${DPINV_IN} w-24 text-right" placeholder="Amount"></td><td class="p-1 text-center"><button class="dpinv-delrow text-rose-400 text-sm" data-i="${i}">✕</button></td></tr>`; }
function dpinvRenderRows(){ const c=document.getElementById('dpinv-items'); if(!c)return; c.innerHTML=`<table class="w-full text-xs"><thead><tr><th class="${_th}">SKU</th><th class="${_th}">Product</th><th class="${_th}">HSN</th><th class="${_th} text-right">Qty</th><th class="${_th} text-right">Rate</th><th class="${_th} text-right">Amount</th><th class="${_th}"></th></tr></thead><tbody>${_dpinvForm.items.map((it,i)=>dpinvGoodsRow(it,i)).join('')}</tbody></table>`;
    c.querySelectorAll('input').forEach(inp=>inp.addEventListener('input',e=>{ const i=+e.target.dataset.i, f=e.target.dataset.f; _dpinvForm.items[i][f]=e.target.value; }));
    c.querySelectorAll('.dpinv-delrow').forEach(b=>b.addEventListener('click',()=>{ _dpinvForm.items.splice(+b.dataset.i,1); if(!_dpinvForm.items.length)_dpinvForm.items=[{}]; dpinvRenderRows(); }));
}
function dpinvGoodsForm(inv){ inv=inv||{}; _dpinvForm={items:(Array.isArray(inv.items)&&inv.items.length?inv.items.map(x=>({...x})):[{sku:'',name:'',hsn:'',qty:'',rate:'',amount:''}])};
    const box=document.getElementById('dpinv-modal-box'); box.classList.remove('max-w-3xl'); box.classList.add('max-w-5xl');
    box.innerHTML=`<div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-slate-800">${inv.id?'Goods Invoice':'New Goods Invoice'}${inv.source&&inv.source!=='manual'?` <span class="text-xs text-amber-600">(extracted from ${inv.source} — review)</span>`:''}</h3><button id="dpinv-x" class="text-slate-400 text-xl">✕</button></div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        ${dpinvField('Invoice No','gi-no',inv.invoice_no)}${dpinvField('Date','gi-date',inv.invoice_date,'date')}${dpinvField('PO Number','gi-po',inv.po_number)}${dpinvField('Grand Total (₹)','gi-total',inv.total_value,'number')}
      </div>
      <div id="dpinv-items" class="border border-slate-100 rounded-lg overflow-x-auto mb-2"></div>
      <button id="dpinv-addrow" class="text-xs text-indigo-600 mb-4">＋ Add line</button>
      <div class="grid grid-cols-3 gap-3 mb-4">${dpinvField('Taxable Amount (₹)','gi-taxable',inv.taxable_amount,'number')}${dpinvField('Tax / IGST (₹)','gi-tax',inv.tax_amount,'number')}${dpinvField('Notes','gi-notes',inv.notes)}</div>
      <div class="flex justify-end gap-2"><button id="dpinv-cancel" class="px-4 py-2 text-sm text-slate-600">Cancel</button><button id="dpinv-save" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg">Save invoice</button></div>`;
    dpinvRenderRows();
    box.querySelector('#dpinv-addrow').addEventListener('click',()=>{ _dpinvForm.items.push({sku:'',name:'',hsn:'',qty:'',rate:'',amount:''}); dpinvRenderRows(); });
    box.querySelector('#dpinv-x').addEventListener('click',dpinvCloseModal); box.querySelector('#dpinv-cancel').addEventListener('click',dpinvCloseModal);
    box.querySelector('#dpinv-save').addEventListener('click',()=>dpinvSaveGoods());
    dpinvOpenModal();
}
async function dpinvSaveGoods(){
    const g=id=>document.getElementById(id).value;
    const body={ invoice_no:g('gi-no'), invoice_date:g('gi-date')||null, po_number:g('gi-po'), total_value:g('gi-total'), taxable_amount:g('gi-taxable'), tax_amount:g('gi-tax'), notes:g('gi-notes'), source:'manual', items:_dpinvForm.items.filter(it=>(it.name||'').trim()||it.qty) };
    if(!body.invoice_no){ showNotification('Invoice No is required',true); return; }
    try{ const r=await fetch('/api/docpharma-invoices/goods',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify(body)}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        showNotification('Goods invoice saved'); dpinvCloseModal(); dpinvLoadGoods();
    }catch(e){ showNotification('Save failed: '+e.message,true); }
}
function dpinvChargeForm(inv){ inv=inv||{}; const box=document.getElementById('dpinv-modal-box'); box.classList.remove('max-w-5xl'); box.classList.add('max-w-3xl');
    box.innerHTML=`<div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-slate-800">${inv.id?'Charge Invoice':'New Charge Invoice'}${inv.source&&inv.source!=='manual'?` <span class="text-xs text-amber-600">(extracted from ${inv.source} — review)</span>`:''}</h3><button id="dpinv-x" class="text-slate-400 text-xl">✕</button></div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">${dpinvField('Invoice No','ci-no',inv.invoice_no)}${dpinvField('Date','ci-date',inv.invoice_date,'date')}${dpinvField('Subject / Period','ci-subject',inv.subject)}</div>
      <table class="w-full text-xs mb-4"><thead><tr><th class="${_th}">Charge</th><th class="${_th} text-right">Qty (orders)</th><th class="${_th} text-right">Rate ₹</th><th class="${_th} text-right">Amount ₹</th></tr></thead><tbody>
        <tr><td class="${_td}">Service (delivered)</td><td class="p-1"><input id="ci-sqty" value="${inv.service_qty||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-srate" value="${inv.service_rate||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-stot" value="${inv.service_total||''}" class="${DPINV_IN} w-full text-right"></td></tr>
        <tr><td class="${_td}">RTO</td><td class="p-1"><input id="ci-rqty" value="${inv.rto_qty||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-rrate" value="${inv.rto_rate||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-rtot" value="${inv.rto_total||''}" class="${DPINV_IN} w-full text-right"></td></tr>
        <tr><td class="${_td}">COD collection</td><td class="p-1"><input id="ci-cqty" value="${inv.cod_qty||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-crate" value="${inv.cod_rate||''}" class="${DPINV_IN} w-full text-right"></td><td class="p-1"><input id="ci-ctot" value="${inv.cod_fee_total||''}" class="${DPINV_IN} w-full text-right"></td></tr>
      </tbody></table>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">${dpinvField('Tax / IGST (₹)','ci-tax',inv.tax_amount,'number')}${dpinvField('Grand Total (₹)','ci-grand',inv.grand_total,'number')}${dpinvField('COD collected (₹)','ci-codcol',inv.cod_collected,'number')}${dpinvField('COD remitted (₹)','ci-codrem',inv.cod_remitted,'number')}</div>
      <div class="flex justify-end gap-2"><button id="dpinv-cancel" class="px-4 py-2 text-sm text-slate-600">Cancel</button><button id="dpinv-save" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg">Save invoice</button></div>`;
    box.querySelector('#dpinv-x').addEventListener('click',dpinvCloseModal); box.querySelector('#dpinv-cancel').addEventListener('click',dpinvCloseModal);
    box.querySelector('#dpinv-save').addEventListener('click',()=>dpinvSaveCharge());
    // Auto-calc: amount = qty × rate per row; tax auto-suggests 18% (until edited); grand = subtotal + tax.
    const $c=id=>box.querySelector('#'+id), nC=v=>{const x=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isNaN(x)?0:x;};
    let taxTouched=!!(inv.tax_amount);
    const rowAmt=(q,r,t)=>{const qty=nC($c(q).value),rate=nC($c(r).value); if(qty&&rate)$c(t).value=Math.round(qty*rate);};
    const recalcGrand=()=>{const sub=nC($c('ci-stot').value)+nC($c('ci-rtot').value)+nC($c('ci-ctot').value); if(!taxTouched)$c('ci-tax').value=sub?Math.round(sub*0.18):''; $c('ci-grand').value=sub?sub+nC($c('ci-tax').value):'';};
    const recalcAll=()=>{rowAmt('ci-sqty','ci-srate','ci-stot');rowAmt('ci-rqty','ci-rrate','ci-rtot');rowAmt('ci-cqty','ci-crate','ci-ctot');recalcGrand();};
    ['ci-sqty','ci-srate','ci-rqty','ci-rrate','ci-cqty','ci-crate'].forEach(id=>$c(id).addEventListener('input',recalcAll));
    ['ci-stot','ci-rtot','ci-ctot'].forEach(id=>$c(id).addEventListener('input',recalcGrand));
    $c('ci-tax').addEventListener('input',()=>{taxTouched=true;recalcGrand();});
    dpinvOpenModal();
}
async function dpinvSaveCharge(){
    const g=id=>document.getElementById(id).value;
    const body={ invoice_no:g('ci-no'), invoice_date:g('ci-date')||null, subject:g('ci-subject'), service_qty:g('ci-sqty'), service_rate:g('ci-srate'), service_total:g('ci-stot'), rto_qty:g('ci-rqty'), rto_rate:g('ci-rrate'), rto_total:g('ci-rtot'), cod_qty:g('ci-cqty'), cod_rate:g('ci-crate'), cod_fee_total:g('ci-ctot'), tax_amount:g('ci-tax'), grand_total:g('ci-grand'), cod_collected:g('ci-codcol'), cod_remitted:g('ci-codrem'), source:'manual' };
    if(!body.invoice_no){ showNotification('Invoice No is required',true); return; }
    try{ const r=await fetch('/api/docpharma-invoices/charge',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify(body)}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        showNotification('Charge invoice saved'); dpinvCloseModal(); dpinvLoadCharge();
    }catch(e){ showNotification('Save failed: '+e.message,true); }
}
async function dpinvUpload(type,file){ showNotification('Reading '+file.name+'…');
    try{ const r=await fetch('/api/docpharma-invoices/parse?type='+type,{method:'POST',headers:{...getAuthHeaders(),'X-Filename':file.name},body:file}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        const ex=d.extracted||{}; ex.source=file.name.toLowerCase().endsWith('.pdf')?'pdf':'excel';
        if(type==='charge') dpinvChargeForm(ex); else dpinvGoodsForm(ex);
        showNotification('Extracted — please review the fields, then Save');
    }catch(e){ showNotification('Could not read file: '+e.message,true); }
}
async function dpinvDelete(type,id,no){ if(!confirm('Delete invoice '+(no||id)+'?'))return;
    try{ const r=await fetch('/api/docpharma-invoices/'+type+'/'+id,{method:'DELETE',headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        showNotification('Deleted'); type==='goods'?dpinvLoadGoods():dpinvLoadCharge();
    }catch(e){ showNotification('Delete failed: '+e.message,true); }
}

// ─── DocPharma Overview tab (operational + value funnel, order-date cohort) ──
let _dpovWired=false,_dpovFrom='',_dpovTo='',_dpovData=null;
function dpovShortM(ym){ const p=String(ym).split('-'); return (DPLED_MONTHS[+p[1]-1]||'').slice(0,3)+" '"+p[0].slice(2); }
// Drill from an Overview figure → Reconciliation, pre-filtered to those orders (order-date cohort → recon's order-date range).
function dpreOverviewDrill(statuses,payment){
    _dpreStatus=(statuses||[]).filter(Boolean); _dprePayment=payment||'all';
    _dpreFrom=_dpovFrom||_dpreFrom; _dpreTo=_dpovTo||_dpreTo; _dpreDFrom=''; _dpreDTo='';
    dpreTab('recon');
    const v=document.getElementById('docpharma-recon-view');
    if(v){ const ff=v.querySelector('#dpre-from'); if(ff)ff.value=_dpreFrom; const tf=v.querySelector('#dpre-to'); if(tf)tf.value=_dpreTo;
        const df=v.querySelector('#dpre-dfrom'); if(df)df.value=''; const dto=v.querySelector('#dpre-dto'); if(dto)dto.value='';
        const pay=v.querySelector('#dpre-payment'); if(pay)pay.value=_dprePayment;
        const wrap=v.querySelector('#dpre-status-multi'); if(wrap){ wrap.querySelectorAll('.dpre-multi-panel input[type=checkbox]').forEach(cb=>cb.checked=_dpreStatus.includes(cb.value)); const btn=wrap.querySelector('.dpre-multi-btn'); if(btn) btn.innerHTML=(_dpreStatus.length===0?'<span class="text-slate-400">All status</span>':_dpreStatus.length===1?((DPRE_STATUS[_dpreStatus[0]]||[_dpreStatus[0]])[0]):`Status: ${_dpreStatus.length}`)+' <span class="text-slate-400">▾</span>'; } }
    dpreLoad();
}
function dpreOverviewInit(){ const sec=document.getElementById('dpre-tab-overview'); if(!sec) return;
    if(!_dpovWired){
        const t=new Date(), f=new Date(t.getFullYear(),t.getMonth()-5,1);
        const fmtM=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;   // YYYY-MM, month granularity (matches Ledger)
        _dpovFrom=fmtM(f); _dpovTo=fmtM(t);
        sec.innerHTML=`<div class="p-6 space-y-4">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div><h2 class="text-sm font-bold text-slate-700">DocPharma throughput · order-date cohort</h2><p class="text-[11px] text-slate-400">Orders grouped by the day they were handed to DocPharma, then their outcomes. Recent months are still in transit.</p></div>
            <div class="flex items-center gap-2 text-xs">
              <span class="text-slate-400">Months</span>
              <input type="month" id="dpov-from" value="${_dpovFrom}" class="border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
              <span class="text-slate-400">→</span>
              <input type="month" id="dpov-to" value="${_dpovTo}" class="border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
              <button id="dpov-apply" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg">Apply</button>
              <button id="dpov-clear" class="px-2 py-1.5 text-slate-500">clear</button>
              <button id="dpov-refresh" class="px-3 py-1.5 bg-slate-800 text-white rounded-lg">↻ Refresh</button>
            </div>
          </div>
          <div id="dpov-body" class="space-y-4"><div class="text-xs text-slate-400 p-4">Loading…</div></div>
        </div>`;
        sec.querySelector('#dpov-apply').addEventListener('click',()=>{ _dpovFrom=sec.querySelector('#dpov-from').value||''; _dpovTo=sec.querySelector('#dpov-to').value||''; dpreOverviewLoad(); });
        sec.querySelector('#dpov-clear').addEventListener('click',()=>{ _dpovFrom=_dpovTo=''; sec.querySelector('#dpov-from').value=''; sec.querySelector('#dpov-to').value=''; dpreOverviewLoad(); });
        sec.querySelector('#dpov-refresh').addEventListener('click',()=>dpreOverviewLoad());
        _dpovWired=true;
    }
    dpreOverviewLoad();
}
async function dpreOverviewLoad(){ const box=document.getElementById('dpov-body'); if(!box) return;
    box.innerHTML='<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">'+ecSkelCards(6)+'</div><div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">'+ecSkelCards(3,'p-5')+'</div>';
    const from=_dpovFrom?`${_dpovFrom}-01`:'', to=_dpovTo?dpledMonthEnd(_dpovTo):'';   // month → full-day range for the API
    try{ const r=await fetch(`/api/docpharma-overview?from=${from}&to=${to}`,{headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _dpovData=d; dpreOverviewRender(d); ecFade('dpov-body');
    }catch(e){ box.innerHTML='<div class="text-xs text-rose-500 p-4">'+e.message+'</div>'; }
}
function dpreOverviewRender(d){
    const box=document.getElementById('dpov-body'); if(!box) return;
    const f=d.funnel, sp=d.split, vf=d.valueFlow, ef=d.efficiency, tr=d.trend||[], cr=d.codRealization||{};
    const INR=OPS_INR, pc=v=>(v*100).toFixed(1)+'%', nfmt=n=>Number(n||0).toLocaleString('en-IN');
    const ho=f.handedOver.orders||1;
    const bar=(label,orders,value,pct,color,st,pay)=>`<div class="dpov-drill cursor-pointer group" data-st="${st||''}" data-pay="${pay||'all'}">
        <div class="flex items-center justify-between text-xs mb-1"><span class="font-semibold text-slate-700 group-hover:text-indigo-600">${label} <span class="text-slate-400 font-normal">${nfmt(orders)}</span></span><span class="text-slate-500 tabular-nums">${INR(value)}${pct!=null?` · ${pct}`:''}</span></div>
        <div class="h-3 rounded bg-slate-100 overflow-hidden"><div class="h-full ${color}" style="width:${Math.max(1,Math.min(100,orders/ho*100)).toFixed(1)}%"></div></div></div>`;
    const chip=(l,o,v,cls,st)=>`<span class="dpov-drill cursor-pointer px-2.5 py-1 rounded-full ${cls}" data-st="${st}" data-pay="all">${l} <b>${nfmt(o)}</b> · ${INR(v)}</span>`;
    const funnelHtml=`<div class="card p-5"><h3 class="text-sm font-bold text-slate-700 mb-4">Order funnel</h3><div class="space-y-3">
        ${bar('Handed over',f.handedOver.orders,f.handedOver.value,null,'bg-slate-400','','all')}
        ${bar('Dispatched',f.dispatched.orders,f.dispatched.value,pc(f.dispatched.orders/ho),'bg-indigo-500','delivered,rto,lost,shipped','all')}
        ${bar('Delivered (served)',f.delivered.orders,f.delivered.value,pc(f.delivered.orders/ho)+' served','bg-emerald-500','delivered','all')}</div>
        <div class="flex flex-wrap gap-2 mt-4 text-xs">
        ${chip('RTO',f.rto.orders,f.rto.value,'bg-rose-50 text-rose-700','rto')}
        ${chip('Lost',f.lost.orders,f.lost.value,'bg-rose-50 text-rose-700','lost')}
        ${chip('Rejected',f.rejected.orders,f.rejected.value,'bg-slate-100 text-slate-500','rejected')}
        ${chip('Cancelled',f.cancelled.orders,f.cancelled.value,'bg-slate-100 text-slate-500','cancelled')}
        ${chip('In transit',f.inTransit.orders,f.inTransit.value,'bg-sky-50 text-sky-700','shipped')}</div></div>`;
    const total=sp.cod.value+sp.prepaid.value||1;
    const splitHtml=`<div class="card p-5"><h3 class="text-sm font-bold text-slate-700 mb-4">COD vs Prepaid</h3>
        <div class="flex h-3 rounded overflow-hidden mb-3"><div class="bg-amber-500" style="width:${(sp.cod.value/total*100).toFixed(1)}%"></div><div class="bg-indigo-500" style="width:${(sp.prepaid.value/total*100).toFixed(1)}%"></div></div>
        <div class="grid grid-cols-2 gap-4">
          <div class="dpov-drill cursor-pointer" data-st="" data-pay="cod"><div class="text-xs text-amber-600 font-semibold">● COD</div><div class="text-lg font-bold text-slate-800 tabular-nums">${INR(sp.cod.value)}</div><div class="text-[11px] text-slate-400">${nfmt(sp.cod.orders)} orders · delivered ${INR(sp.cod.delivered)}</div></div>
          <div class="dpov-drill cursor-pointer" data-st="" data-pay="prepaid"><div class="text-xs text-indigo-600 font-semibold">● Prepaid</div><div class="text-lg font-bold text-slate-800 tabular-nums">${INR(sp.prepaid.value)}</div><div class="text-[11px] text-slate-400">${nfmt(sp.prepaid.orders)} orders · delivered ${INR(sp.prepaid.delivered)}</div></div>
        </div>
        <div class="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-500">COD delivered (DocPharma collects) <b>${INR(cr.codDeliveredValue||0)}</b> · remitted to date <b class="text-emerald-700">${INR(cr.received||0)}</b>${cr.codDeliveredValue?` · realized ${pc((cr.received||0)/cr.codDeliveredValue)}`:''}</div></div>`;
    const vfRow=(l,v,c,note)=>`<div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0"><span class="text-sm text-slate-600">${l}${note?` <span class="text-[11px] text-slate-400">${note}</span>`:''}</span><span class="text-sm font-semibold ${c||'text-slate-800'} tabular-nums">${INR(v)}</span></div>`;
    const valueHtml=`<div class="card p-5"><h3 class="text-sm font-bold text-slate-700 mb-3">Value flow</h3>
        ${vfRow('GMV handed over',vf.gmvHanded,'text-slate-800')}
        ${vfRow('Delivered GMV (served)',vf.deliveredGmv,'text-emerald-700')}
        ${vfRow('RTO value (returned)',vf.rtoValue,'text-rose-600','lost sale')}
        ${vfRow('Lost value',vf.lostValue,'text-rose-600','compensated')}
        ${vfRow('In-transit value',vf.inTransitValue,'text-sky-600','at risk')}</div>`;
    const tile=(l,v,c)=>`<div class="card p-4 lift"><div class="text-xs text-slate-400 uppercase tracking-wide">${l}</div><div class="text-2xl font-bold ${c||'text-slate-800'} tabular-nums mt-1">${v}</div></div>`;
    const effHtml=`<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        ${tile('Delivery rate',pc(ef.deliveryRate),'text-emerald-600')}
        ${tile('RTO rate',pc(ef.rtoRate),'text-rose-600')}
        ${tile('Rejection rate',pc(ef.rejectionRate),'text-slate-600')}
        ${tile('Avg order value',INR(ef.avgOrderValue),'text-slate-700')}
        ${tile('Charge / delivered',INR(ef.chargePerDelivered),'text-indigo-600')}
        ${tile('Charge % of del. GMV',pc(ef.chargePctOfDeliveredGmv),'text-indigo-600')}</div>`;
    const maxH=44;
    const trendCols=tr.map(m=>{ const h=Math.max(2,Math.round(m.deliveryRate*maxH)); const col=m.incomplete?'bg-slate-300':'bg-emerald-500';
        return `<div class="flex flex-col items-center gap-1" title="${dpledMonLabel(m.month)} · delivery ${pc(m.deliveryRate)} · ${m.delivered}/${m.delivered+m.rto+m.lost} closed${m.incomplete?' · still in transit':''}"><div class="flex items-end" style="height:${maxH}px"><div class="w-4 ${col} rounded-t" style="height:${h}px"></div></div><div class="text-[9px] text-slate-400 whitespace-nowrap">${dpovShortM(m.month)}</div></div>`; }).join('');
    const trendHtml=tr.length?`<div class="card p-5"><div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold text-slate-700">Delivery-rate trend</h3><span class="text-[11px] text-slate-400">grey = cohort still in transit</span></div><div class="flex items-end gap-3 overflow-x-auto pb-1">${trendCols}</div></div>`:'';
    // Monthly cohort detail table (order-date cohort, newest first)
    const th='px-3 py-2 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60 whitespace-nowrap',thl=th.replace('text-right','text-left');
    const td='px-3 py-2 text-sm text-slate-700 border-b border-slate-100 text-right tabular-nums whitespace-nowrap';
    const drate=r=>r>=0.7?'text-emerald-600':r>=0.5?'text-amber-600':'text-rose-600';
    const mrows=[...tr].reverse().map(m=>`<tr class="hover:bg-slate-50"><td class="${td} text-left font-semibold">${dpledMonLabel(m.month)}${m.incomplete?' <span class="text-amber-600" title="cohort still in transit — delivery rate will rise">⏳</span>':''}</td><td class="${td}">${nfmt(m.orders)}</td><td class="${td} text-indigo-600">${nfmt(m.dispatched)}</td><td class="${td} text-emerald-700">${nfmt(m.delivered)}</td><td class="${td} text-rose-600">${nfmt(m.rto)}</td><td class="${td}">${m.lost||0}</td><td class="${td} text-slate-500">${nfmt(m.rejected)}</td><td class="${td} text-slate-500">${nfmt(m.cancelled)}</td><td class="${td} text-sky-600">${nfmt(m.inTransit)}</td><td class="${td} font-semibold ${drate(m.deliveryRate)}">${pc(m.deliveryRate)}</td><td class="${td}">${INR(m.handedValue)}</td><td class="${td} text-emerald-700">${INR(m.deliveredValue)}</td></tr>`).join('');
    const monthlyHtml=tr.length?`<div class="card p-0 overflow-hidden"><div class="px-5 py-3 border-b border-slate-100"><h3 class="text-sm font-bold text-slate-700">Monthly cohort detail</h3><p class="text-[11px] text-slate-400">Each order counted in the month it was handed to DocPharma · ⏳ = still in transit (delivery rate will rise)</p></div><div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr><th class="${thl}">Month</th><th class="${th}">Handed</th><th class="${th}">Dispatched</th><th class="${th}">Delivered</th><th class="${th}">RTO</th><th class="${th}">Lost</th><th class="${th}">Rej</th><th class="${th}">Cancel</th><th class="${th}">In-transit</th><th class="${th}">Delivery %</th><th class="${th}">GMV handed</th><th class="${th}">Delivered GMV</th></tr></thead><tbody>${mrows}</tbody></table></div></div>`:'';
    box.innerHTML=effHtml
        +`<div class="grid grid-cols-1 lg:grid-cols-3 gap-4"><div class="lg:col-span-2">${funnelHtml}</div>${valueHtml}</div>`
        +`<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">${splitHtml}${trendHtml}</div>`
        +monthlyHtml;
    box.querySelectorAll('.dpov-drill').forEach(el=>el.addEventListener('click',()=>{ const st=(el.dataset.st||'').split(',').filter(Boolean); dpreOverviewDrill(st, el.dataset.pay); }));
}

// ─── DocPharma Ledger tab (Receivable / Payable / Net / Outstanding) ─────────
// Smoothness helpers (reusable): re-trigger a fade-in on freshly-rendered containers; skeleton card placeholders.
function ecFade(){ for(const id of arguments){ const el=document.getElementById(id); if(el){ el.classList.remove('ec-fade'); void el.offsetWidth; el.classList.add('ec-fade'); } } }
const ecSkelCards=(n,cls)=>Array.from({length:n}).map(()=>`<div class="card ${cls||'p-4'}"><div class="skl" style="height:10px;width:55%"></div><div class="skl" style="height:22px;width:78%;margin-top:11px"></div><div class="skl" style="height:9px;width:66%;margin-top:10px"></div></div>`).join('');
let _dpreLedgerWired=false, _dpledRows=[], _dpledCharges=[], _dpledPayments=[], _dpledFifo=null, _dpledRate={}, _dpledFrom='', _dpledTo='', _dpledOpen={}, _dpledCard='';
const DPLED_SETTLE={settled:['Settled','bg-emerald-100 text-emerald-700'],partial:['Partial','bg-amber-100 text-amber-700'],outstanding:['Outstanding','bg-rose-100 text-rose-700'],na:['—','text-slate-300']};
const DPLED_MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
function dpledMonLabel(ym){ if(!ym||ym==='unknown')return 'Unknown'; const p=String(ym).split('-'); const mi=parseInt(p[1],10)-1; return (DPLED_MONTHS[mi]||p[1])+'-'+p[0]; }
function dpreLedgerInit(){ const sec=document.getElementById('dpre-tab-ledger'); if(!sec) return;
    if(!_dpreLedgerWired){ sec.innerHTML=`<div class="p-6 space-y-5">
        <div class="flex items-center justify-between flex-wrap gap-2"><h2 class="text-sm font-bold text-slate-700">DocPharma account · Receivable vs Payable</h2>
          <div class="flex items-center gap-2 text-xs">
            <span class="text-slate-400">Months</span>
            <input type="month" id="dpled-from" class="border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
            <span class="text-slate-400">→</span>
            <input type="month" id="dpled-to" class="border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
            <button id="dpled-apply" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg">Apply</button>
            <button id="dpled-clear" class="px-2 py-1.5 text-slate-500">clear</button>
            <button id="dpled-csv" class="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400">⬇ CSV</button>
            <button id="dpled-pdf" class="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400">⬇ PDF</button>
            <button id="dpled-refresh" class="px-3 py-1.5 bg-slate-800 text-white rounded-lg">↻ Refresh</button>
          </div></div>
        <div id="dpled-kpis" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"></div>
        <div id="dpled-detail"></div>
        <div id="dpled-ops" class="space-y-3"></div>
        <div class="card p-0 overflow-hidden"><div class="px-5 py-3 border-b border-slate-100"><h2 class="text-sm font-bold text-slate-700">Monthly ledger</h2><p class="text-[11px] text-slate-400">Charges grouped by delivered/RTO month · invoices by their period · payments by date · click a month to break it down</p></div><div id="dpled-table" class="overflow-x-auto"></div></div>
      </div>`;
        sec.querySelector('#dpled-refresh').addEventListener('click',()=>dpreLedgerLoad());
        sec.querySelector('#dpled-apply').addEventListener('click',()=>{ _dpledFrom=sec.querySelector('#dpled-from').value||''; _dpledTo=sec.querySelector('#dpled-to').value||''; dpledRender(); });
        sec.querySelector('#dpled-clear').addEventListener('click',()=>{ _dpledFrom=_dpledTo=''; sec.querySelector('#dpled-from').value=''; sec.querySelector('#dpled-to').value=''; dpledRender(); });
        sec.querySelector('#dpled-csv').addEventListener('click',dpledExportCsv);
        sec.querySelector('#dpled-pdf').addEventListener('click',dpledPrint);
        _dpreLedgerWired=true;
    }
    dpreLedgerLoad();
}
async function dpreLedgerLoad(){ const k=document.getElementById('dpled-kpis'); if(k)k.innerHTML=ecSkelCards(6);
    const ops=document.getElementById('dpled-ops'); if(ops)ops.innerHTML='';
    const tbl=document.getElementById('dpled-table'); if(tbl)tbl.innerHTML='<div class="p-4 space-y-2">'+Array.from({length:6}).map(()=>'<div class="skl" style="height:34px;width:100%"></div>').join('')+'</div>';
    try{ const r=await fetch('/api/docpharma-ledger',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        _dpledRows=d.rows||[]; _dpledCharges=d.charges||[]; _dpledPayments=d.payments||[]; _dpledFifo=(d.summary||{}).fifo||null; _dpledRate=d.rateCard||{}; dpledRender();
        ecFade('dpled-kpis','dpled-ops','dpled-table');
    }catch(e){ if(k)k.innerHTML='<div class="col-span-6 text-xs text-rose-500 p-4">'+e.message+'</div>'; }
}
const dpledInRange=mk=>{ if(!mk)return false; if(mk==='unknown')return !_dpledFrom&&!_dpledTo; if(_dpledFrom&&mk<_dpledFrom)return false; if(_dpledTo&&mk>_dpledTo)return false; return true; };
function dpledVisibleRows(){ return _dpledRows.filter(m=>{ if(m.month==='unknown') return !_dpledFrom&&!_dpledTo; if(_dpledFrom&&m.month<_dpledFrom)return false; if(_dpledTo&&m.month>_dpledTo)return false; return true; }); }
function dpledMonthEnd(ym){ const p=String(ym).split('-'); const d=new Date(+p[0],+p[1],0); return `${p[0]}-${String(+p[1]).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
// Billing variance: DocPharma's invoiced grand total vs our rate-card expectation incl. est. GST. Flags material over/under-billing.
function dpledBillVar(g){ if(!(g.invGrand>0))return null; const exp=g.expCharges*1.18, diff=g.invGrand-exp, pct=exp?diff/exp*100:0; const flag=Math.abs(diff)>100&&Math.abs(pct)>=5; return {exp,act:g.invGrand,diff,pct,flag}; }
// Drill-through: jump to the Reconciliation tab, pre-filtered to the exact orders behind a ledger figure.
function dpledDrill(statuses,payment){
    _dpreStatus=(statuses||[]).filter(Boolean); _dprePayment=payment||'all';
    _dpreDFrom=_dpledFrom?`${_dpledFrom}-01`:''; _dpreDTo=_dpledTo?dpledMonthEnd(_dpledTo):'';
    dpreTab('recon');
    const v=document.getElementById('docpharma-recon-view');
    if(v){ const df=v.querySelector('#dpre-dfrom'); if(df)df.value=_dpreDFrom; const dto=v.querySelector('#dpre-dto'); if(dto)dto.value=_dpreDTo; const pay=v.querySelector('#dpre-payment'); if(pay)pay.value=_dprePayment;
        const wrap=v.querySelector('#dpre-status-multi'); if(wrap){ wrap.querySelectorAll('.dpre-multi-panel input[type=checkbox]').forEach(cb=>cb.checked=_dpreStatus.includes(cb.value)); const btn=wrap.querySelector('.dpre-multi-btn'); if(btn) btn.innerHTML=(_dpreStatus.length===0?'<span class="text-slate-400">All status</span>':_dpreStatus.length===1?((DPRE_STATUS[_dpreStatus[0]]||[_dpreStatus[0]])[0]):`Status: ${_dpreStatus.length}`)+' <span class="text-slate-400">▾</span>'; } }
    dpreLoad();
}
function dpledExportCsv(){
    const rows=dpledVisibleRows(); if(!rows.length){ showNotification&&showNotification('Nothing to export',true); return; }
    const hdr=['Month','Total orders','Delivered','RTO','RTO COD','RTO Prepaid','Rejected/Cancelled','Lost','Prepaid orders','Expected charges','Invoiced (incl tax)','Variance','COD collected','Prepaid value','Lost comp','Net remit','Paid (FIFO)','Settled','Outstanding'];
    const esc=v=>{ const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
    const R=v=>Math.round(v||0), lines=[hdr.join(',')]; const t={};
    rows.forEach(m=>{ ['totalOrders','delivered','rto','rtoCod','rtoPrepaid','rejected','lost','prepaidOrders','expCharges','codCollected','prepaidValue','lostComp','remitExpected','paidNet','outstanding'].forEach(k=>t[k]=(t[k]||0)+(m[k]||0)); t.inv=(t.inv||0)+(m.invoices?(m.invGrand||m.invCharges):0);
        lines.push([dpledMonLabel(m.month),m.totalOrders||0,m.delivered,m.rto,m.rtoCod||0,m.rtoPrepaid||0,m.rejected||0,m.lost||0,m.prepaidOrders||0,R(m.expCharges),m.invoices?R(m.invGrand||m.invCharges):'',m.variance==null?'':R(m.variance),R(m.codCollected),R(m.prepaidValue),R(m.lostComp),R(m.remitExpected),R(m.paidNet),m.settled&&m.settled!=='na'?m.settled:'',R(m.outstanding)].map(esc).join(',')); });
    lines.push(['TOTAL',t.totalOrders,t.delivered,t.rto,t.rtoCod,t.rtoPrepaid,t.rejected,t.lost,t.prepaidOrders,R(t.expCharges),R(t.inv),'',R(t.codCollected),R(t.prepaidValue),R(t.lostComp),R(t.remitExpected),R(t.paidNet),'',R(t.outstanding)].map(esc).join(','));
    const range=(_dpledFrom||_dpledTo)?`_${_dpledFrom||'start'}_to_${_dpledTo||'end'}`:'_all';
    const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}), a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=`docpharma-ledger${range}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
async function dpledPrint(){
    const rows=dpledVisibleRows(); if(!rows.length){ showNotification&&showNotification('Nothing to export',true); return; }
    const g=rows.reduce((a,m)=>{ ['codCollected','lostComp','invGrand','paidNet'].forEach(k=>a[k]=(a[k]||0)+(m[k]||0)); return a; },{codCollected:0,lostComp:0,invGrand:0,paidNet:0});
    const receivable=g.codCollected+g.lostComp, net=receivable-g.invGrand, paid=g.paidNet, outstanding=net-paid;
    const period=(_dpledFrom||_dpledTo)?`${_dpledFrom?dpledMonLabel(_dpledFrom):'start'} to ${_dpledTo?dpledMonLabel(_dpledTo):'latest'}`:'All periods';
    const fifo=_dpledFifo?{...(_dpledFifo),settledThroughLabel:_dpledFifo.settledThrough?dpledMonLabel(_dpledFifo.settledThrough):'—'}:null;
    const payload={ period, totals:{receivable,payableInvoiced:g.invGrand,net,paid,outstanding}, fifo,
        rows: rows.map(m=>({ month:dpledMonLabel(m.month), total:m.totalOrders||0, delivered:m.delivered, rto:m.rto, rejected:m.rejected||0, expCharges:Math.round(m.expCharges||0),
            invoiced:m.invoices?Math.round(m.invGrand||m.invCharges||0):null, codCollected:Math.round(m.codCollected||0), lostComp:Math.round(m.lostComp||0),
            remitExpected:Math.round(m.remitExpected||0), paidNet:Math.round(m.paidNet||0), settled:m.settled, outstanding:Math.round(m.outstanding||0) })) };
    try{
        const r=await fetch('/api/docpharma-ledger-pdf',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify(payload)});
        if(!r.ok) throw new Error('server '+r.status);
        const blob=await r.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
        const range=(_dpledFrom||_dpledTo)?`_${_dpledFrom||'start'}_to_${_dpledTo||'end'}`:'_all';
        a.download=`docpharma-ledger${range}.pdf`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    }catch(e){ showNotification&&showNotification('PDF failed: '+e.message,true); }
}
// Breakdown panel for the selected KPI card, computed from the filtered rows/invoices/payments.
function dpledCardDetail(g,receivable,net,paid,outstanding){
    if(!_dpledCard) return '';
    const line=(l,v,c,note,drill)=>{ const lab=drill?`<button class="dpled-drill text-sm text-indigo-600 hover:underline text-left" data-st="${drill.st||''}" data-pay="${drill.pay||'all'}">${l} <span class="text-[10px]">↗</span></button>`:`<span class="text-sm text-slate-600">${l}</span>`; return `<div class="flex items-start justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0"><div>${lab}${note?`<div class="text-[11px] text-slate-400">${note}</div>`:''}</div><span class="text-sm font-semibold ${c||'text-slate-800'} tabular-nums whitespace-nowrap">${v}</span></div>`; };
    const subtotal=(l,v,c)=>`<div class="flex items-center justify-between gap-3 py-2 mt-1 border-t-2 border-slate-200"><span class="text-sm font-bold text-slate-700">${l}</span><span class="text-base font-bold ${c||'text-slate-800'} tabular-nums">${v}</span></div>`;
    const wrap=(title,inner)=>`<div class="card p-5 border-l-4 border-indigo-400"><div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold text-slate-700">${title}</h3><button id="dpled-detclose" class="text-slate-400 text-lg leading-none">✕</button></div>${inner}</div>`;
    const invs=_dpledCharges.filter(iv=>dpledInRange(iv._month));
    const pays=_dpledPayments.filter(p=>dpledInRange(p._month));
    const R=v=>OPS_INR(Math.round(v||0));
    const bv=dpledBillVar(g);
    const varNote=bv&&bv.flag?`<div class="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">⚠ <b>Billing variance:</b> DocPharma invoiced ${R(bv.act)} vs expected ${R(bv.exp)} incl. GST — <b>${bv.diff>0?'+':''}${R(bv.diff)} (${bv.pct>0?'+':''}${bv.pct.toFixed(1)}%)</b>. ${bv.diff>0?'They billed more than the rate card implies — review before paying.':'They billed less than expected.'}</div>`:'';
    // Payable = DocPharma's actual invoices (where billed) + rate-card estimate for months not yet invoiced. Show both parts.
    const invPart=g.invGrand, estPart=g.unInvEst||0;
    // Only invoiced charges are deducted. The un-invoiced rate-card estimate is shown as a memo (NOT subtracted from Net/Outstanding).
    const payableLines=()=>{ let s=line('Payable — invoiced (actual, incl tax)',`− ${R(invPart)}`,'text-red-600',`DocPharma bills · tax ${R(g.invTax)}`);
        if(estPart>0.5) s+=line('Un-invoiced charges (memo, not deducted)',`(${R(estPart)})`,'text-slate-400',`rate card ${R(estPart/1.18)} + est 18% GST — excluded until DocPharma actually invoices`);
        return s; };
    const basisFoot=`<div class="mt-3 pt-2 border-t border-slate-100 text-[11px] text-amber-600">↑ While this card is selected, the <b>Net</b> & <b>Outstanding</b> cards above are re-based on this figure (what-if). Click again to restore the blended default.</div>`;
    let inner='';
    if(_dpledCard==='receivable'){
        inner=line('COD collected',`+ ${R(g.codCollected)}`,'text-emerald-700',`${g.codOrders} COD orders — DocPharma collected & owes you`,{st:'delivered',pay:'cod'})
            +line('Lost compensation',`+ ${R(g.lostComp)}`,'text-emerald-700',`${g.lost} lost shipments — full order value reimbursed`,{st:'lost'})
            +subtotal('Total receivable',R(receivable),'text-emerald-700')
            +`<div class="mt-3 pt-2 text-[11px] text-slate-400">For reference — not receivable from DocPharma:</div>`
            +line('Prepaid delivered',R(g.prepaidValue),'text-slate-500',`${g.prepaidOrders} prepaid orders — already paid to you online, DocPharma collects nothing`,{st:'delivered',pay:'prepaid'});
    } else if(_dpledCard==='payableExpected'){
        const gst=Math.round(g.expCharges*0.18);
        inner=line('Flat service',`+ ${R(g.expService)}`,'text-slate-700',`${g.serviceOrders} billable orders (delivered + RTO)`,{st:'delivered,rto'})
            +line('RTO charge',`+ ${R(g.expRto)}`,'text-slate-700',`${g.rto} RTO orders`,{st:'rto'})
            +line('COD collection fee',`+ ${R(g.expCod)}`,'text-slate-700',`${g.codOrders} COD orders`,{st:'delivered',pay:'cod'})
            +subtotal('Subtotal (rate card)',R(g.expCharges),'text-slate-800')
            +line('Est. GST @ 18%',`+ ${R(gst)}`,'text-slate-500','expected — actual tax per DocPharma invoice')
            +subtotal('Est. total incl GST',R(g.expCharges+gst),'text-slate-800')
            +basisFoot;
    } else if(_dpledCard==='payableInvoiced'){
        const tdc='px-3 py-2 text-sm border-b border-slate-100 tabular-nums',thc='px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60';
        if(!invs.length) inner=`<div class="text-sm text-slate-400 py-4 text-center">No DocPharma charge invoices recorded for this period. Add them in the Invoices tab.</div>`+basisFoot;
        else{ let tc=0,tt=0,tg=0; const body=invs.map(iv=>{ const c=+iv.total_charges||0,t=+iv.tax_amount||0,gt=(+iv.grand_total||0)||(c+t); tc+=c;tt+=t;tg+=gt; return `<tr><td class="${tdc} text-left font-semibold">${iv.invoice_no||'—'}</td><td class="${tdc} text-left text-slate-500">${iv.subject||dpledMonLabel(iv._month)}</td><td class="${tdc} text-right">${R(c)}</td><td class="${tdc} text-right">${R(t)}</td><td class="${tdc} text-right font-semibold text-red-600">${R(gt)}</td></tr>`;}).join('');
            inner=`<div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr><th class="${thc} text-left">Invoice</th><th class="${thc} text-left">Period / Subject</th><th class="${thc} text-right">Charges</th><th class="${thc} text-right">Tax</th><th class="${thc} text-right">Grand total</th></tr></thead><tbody>${body}<tr class="bg-slate-50 font-bold"><td class="${tdc} text-left" colspan="2">Total (${invs.length})</td><td class="${tdc} text-right">${R(tc)}</td><td class="${tdc} text-right">${R(tt)}</td><td class="${tdc} text-right text-red-600">${R(tg)}</td></tr></tbody></table></div>`+varNote+basisFoot; }
    } else if(_dpledCard==='netExpected'){
        inner=line('Receivable',`+ ${R(receivable)}`,'text-emerald-700',`COD collected ${R(g.codCollected)} + lost comp ${R(g.lostComp)}`)
            +payableLines()
            +subtotal('Net DocPharma should remit',R(net),'text-indigo-600');
    } else if(_dpledCard==='paymentsReceived'){
        const tdc='px-3 py-2 text-sm border-b border-slate-100 tabular-nums',thc='px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60';
        if(!pays.length) inner=`<div class="text-sm text-slate-400 py-4 text-center">No remittances recorded for this period. Add them in the Payments tab — they apply oldest-first (FIFO) across the whole account.</div>`;
        else{ let tot=0; const body=pays.map(p=>{ const amt=(+p.amount||0)*((p.direction||'received')==='received'?1:-1); tot+=amt; return `<tr><td class="${tdc} text-left">${(p.payment_date||'').slice(0,10).split('-').reverse().join('-')||'—'}</td><td class="${tdc} text-left text-slate-500">${p.reference||'—'}</td><td class="${tdc} text-left text-slate-500">${p.method||'—'}</td><td class="${tdc} text-right font-semibold ${amt>=0?'text-emerald-700':'text-rose-600'}">${amt>=0?'+ ':'− '}${R(Math.abs(amt))}</td></tr>`;}).join('');
            inner=`<div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr><th class="${thc} text-left">Date</th><th class="${thc} text-left">Reference</th><th class="${thc} text-left">Method</th><th class="${thc} text-right">Amount</th></tr></thead><tbody>${body}<tr class="bg-slate-50 font-bold"><td class="${tdc} text-left" colspan="3">Net received (${pays.length})</td><td class="${tdc} text-right text-emerald-700">${R(tot)}</td></tr></tbody></table></div>`; }
    } else if(_dpledCard==='outstanding'){
        inner=line('COD collected',`+ ${R(g.codCollected)}`,'text-emerald-700',`${g.codOrders} COD orders`,{st:'delivered',pay:'cod'})
            +line('Lost compensation',`+ ${R(g.lostComp)}`,'text-emerald-700',`${g.lost} lost shipments`,{st:'lost'})
            +subtotal('Receivable',R(receivable),'text-emerald-700')
            +payableLines()
            +subtotal('Net should remit',R(net),'text-indigo-600')
            +line('Payments received',`− ${R(paid)}`,'text-emerald-700','FIFO-applied oldest-first · from Payments tab')
            +subtotal('Outstanding',R(outstanding),outstanding>=0?'text-amber-600':'text-rose-600')
            +varNote
            +`<div class="mt-3 pt-2 text-[11px] text-slate-400">Prepaid delivered (info): ${R(g.prepaidValue)} across ${g.prepaidOrders} orders — settled online, outside DocPharma's COD remittance.</div>`;
    }
    return `<div class="mb-1">${wrap(({receivable:'Receivable breakdown',payableExpected:'Expected charges (rate card)',payableInvoiced:'DocPharma charge invoices',netExpected:'Net remittance',paymentsReceived:'Payments received',outstanding:'Outstanding — full statement'})[_dpledCard]||'Breakdown',inner)}</div>`;
}
// Render KPIs + monthly table from _dpledRows, honouring the month filter. All figures recompute from the visible rows.
function dpledRender(){
    const k=document.getElementById('dpled-kpis'); if(!k)return;
    const rows=dpledVisibleRows();
    const g=rows.reduce((a,m)=>{ a.codCollected+=m.codCollected||0; a.codOrders+=m.codOrders||0; a.prepaidValue+=m.prepaidValue||0; a.prepaidOrders+=m.prepaidOrders||0; a.lostComp+=m.lostComp||0; a.lost+=m.lost||0; a.delivered+=m.delivered||0; a.rto+=m.rto||0; a.rtoCod+=m.rtoCod||0; a.rtoPrepaid+=m.rtoPrepaid||0; a.rtoValue+=m.rtoValue||0; a.rejected+=m.rejected||0; a.rejectedValue+=m.rejectedValue||0; a.totalOrders+=m.totalOrders||0; a.expService+=m.expService||0; a.expRto+=m.expRto||0; a.expCod+=m.expCod||0; a.expCharges+=m.expCharges||0; a.invGrand+=m.invGrand||0; a.invCharges+=m.invCharges||0; a.invTax+=m.invTax||0; a.payableActual+=(m.invGrand||0); a.unInvEst+=(m.invGrand>0?0:Math.round((m.expCharges||0)*1.18)); a.paidApplied+=m.paidNet||0; return a; },{codCollected:0,codOrders:0,prepaidValue:0,prepaidOrders:0,lostComp:0,lost:0,delivered:0,rto:0,rtoCod:0,rtoPrepaid:0,rtoValue:0,rejected:0,rejectedValue:0,totalOrders:0,expService:0,expRto:0,expCod:0,expCharges:0,invGrand:0,invCharges:0,invTax:0,payableActual:0,unInvEst:0,paidApplied:0});
    g.serviceOrders=g.delivered+g.rto; g.paymentsIn=g.paidApplied; g.paymentsOut=0;
    const receivable=g.codCollected+g.lostComp, paid=g.paidApplied;
    // Payable basis is a what-if toggle: clicking Payable·expected / Payable·invoiced re-bases Net & Outstanding on that figure.
    const basisMode=_dpledCard==='payableExpected'?'expected':_dpledCard==='payableInvoiced'?'invoiced':'';
    const basisPayable=basisMode==='expected'?Math.round(g.expCharges*1.18):basisMode==='invoiced'?g.invGrand:g.payableActual;
    const net=receivable-basisPayable, outstanding=net-paid;
    const bv=dpledBillVar(g);
    const wi=basisMode?` · <span class="text-amber-600 font-semibold">what-if: ${basisMode}</span>`:'';
    const card=(key,l,v,sub,acc)=>`<div class="card p-4 cursor-pointer lift ${_dpledCard===key?'ring-2 ring-indigo-400':''}" data-card="${key}"><div class="flex items-center justify-between"><div class="text-xs text-slate-400 uppercase tracking-wide">${l}</div><span class="text-slate-300 text-[10px]">${_dpledCard===key?'▾':'▸'}</span></div><div class="text-2xl font-bold ${acc||'text-slate-800'} tabular-nums mt-1">${v}</div><div class="text-xs text-slate-400 mt-0.5">${sub||''}</div></div>`;
    const invSub=bv&&bv.flag?`<span class="text-amber-600 font-semibold">⚠ ${bv.pct>0?'+':''}${bv.pct.toFixed(1)}% vs expected</span>`:'DocPharma bills (incl tax)';
    const netSub=`receivable − ${basisMode==='expected'?'expected (incl GST)':'invoiced only'}${wi}`;
    const outSub=(bv&&bv.flag?`<span class="text-amber-600 font-semibold">⚠ billing ${bv.pct>0?'+':''}${bv.pct.toFixed(1)}%</span> · ${outstanding>=0?'owes you':'you owe'}`:(outstanding>=0?'DocPharma owes you':'you owe DocPharma'))+wi;
    k.innerHTML=card('receivable','Receivable',OPS_INR(receivable),`COD ${OPS_INR(g.codCollected)} + lost ${OPS_INR(g.lostComp)}`,'text-emerald-600')
      +card('payableExpected','Payable · expected',OPS_INR(Math.round(g.expCharges*1.18)),'rate card + est 18% GST','text-slate-700')
      +card('payableInvoiced','Payable · invoiced',OPS_INR(g.invGrand||g.invCharges),invSub,'text-red-600')
      +card('netExpected','Net (should remit)',OPS_INR(net),netSub,'text-indigo-600')
      +card('paymentsReceived','Payments received',OPS_INR(paid),'','text-emerald-700')
      +(()=>{ const outInv=receivable-g.invGrand-paid, outExp=receivable-Math.round(g.expCharges*1.18)-paid;
          const sub=`<span class="text-slate-500">invoiced-only · ${outInv>=0?'owes you':'you owe'}</span><br><span class="text-slate-400">if billed @ rate card: <b class="text-amber-600">${OPS_INR(outExp)}</b></span>`;
          return card('outstanding','Outstanding',OPS_INR(outInv),sub,outInv>=0?'text-amber-600':'text-rose-600'); })();
    const dt=document.getElementById('dpled-detail'); if(dt){ dt.innerHTML=dpledCardDetail(g,receivable,net,paid,outstanding); const cl=dt.querySelector('#dpled-detclose'); if(cl)cl.addEventListener('click',()=>{ _dpledCard=''; dpledRender(); });
        dt.querySelectorAll('.dpled-drill').forEach(b=>b.addEventListener('click',()=>dpledDrill((b.dataset.st||'').split(',').filter(Boolean),b.dataset.pay))); }
    document.querySelectorAll('#dpled-kpis [data-card]').forEach(c=>c.addEventListener('click',()=>{ const key=c.getAttribute('data-card'); _dpledCard=_dpledCard===key?'':key; dpledRender(); }));
    // ── Detail cards: Operations + Charges & collection (aggregated over the filtered months) ──
    const ops=document.getElementById('dpled-ops');
    if(ops){ const nf=x=>Number(x||0).toLocaleString('en-IN'), gst=Math.round((g.expCharges||0)*0.18);
        const deliveredGmv=(g.codCollected||0)+(g.prepaidValue||0), totalGmv=deliveredGmv+(g.rtoValue||0)+(g.lostComp||0)+(g.rejectedValue||0);
        const icard=(l,v,sub,acc,st,pay,val)=>`<div class="card p-3.5 ${st!=null?'cursor-pointer lift dpled-ocard':''}"${st!=null?` data-st="${st}" data-pay="${pay||'all'}"`:''}><div class="text-[11px] text-slate-400 uppercase tracking-wide">${l}</div><div class="flex items-baseline gap-2 mt-0.5"><div class="text-xl font-bold ${acc||'text-slate-800'} tabular-nums">${v}</div>${val?`<div class="text-sm font-semibold text-slate-500 tabular-nums">${val}</div>`:''}</div><div class="text-[11px] text-slate-400 mt-0.5">${sub||''}</div></div>`;
        const sec=(title,cards)=>`<div><div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 mt-1">${title}</div><div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">${cards}</div></div>`;
        const opsCards=icard('Total orders',nf(g.totalOrders),`Deliv ${nf(g.delivered)} · RTO ${nf(g.rto)} · Rej ${nf(g.rejected)}`,'text-slate-800','delivered,rto,lost,rejected,cancelled,shipped',undefined,OPS_INR(totalGmv))
            +icard('Delivered',nf(g.delivered),`COD ${nf(g.codOrders)} · Prepaid ${nf(g.prepaidOrders)}`,'text-emerald-600','delivered',undefined,OPS_INR(deliveredGmv))
            +icard('RTO',nf(g.rto),`COD ${nf(g.rtoCod)} · Prepaid ${nf(g.rtoPrepaid)}`,'text-rose-600','rto',undefined,OPS_INR(g.rtoValue))
            +icard('Rejected / Cancelled',nf(g.rejected),'rejected + cancelled','text-slate-600','rejected,cancelled',undefined,OPS_INR(g.rejectedValue))
            +icard('Lost',nf(g.lost),'comp = full order value',g.lost?'text-rose-600':'text-slate-400','lost',undefined,OPS_INR(g.lostComp))
            +icard('Prepaid delivered',OPS_INR(g.prepaidValue),`${nf(g.prepaidOrders)} orders · memo`,'text-slate-500','delivered','prepaid');
        const chargeCards=icard('Flat service',OPS_INR(g.expService),`${nf(g.serviceOrders)} billable orders`,'text-indigo-600')
            +icard('RTO charge',OPS_INR(g.expRto),`${nf(g.rto)} RTO orders`,'text-rose-600')
            +icard('COD fee',OPS_INR(g.expCod),`${nf(g.codOrders)} COD orders`,'text-sky-600')
            +icard('Est GST 18%',OPS_INR(gst),`on ${OPS_INR(g.expCharges)} subtotal`,'text-slate-500')
            +icard('COD collected',OPS_INR(g.codCollected),`${nf(g.codOrders)} COD orders`,'text-emerald-700','delivered','cod')
            +icard('Lost compensation',OPS_INR(g.lostComp),`${nf(g.lost)} shipments`,'text-emerald-700','lost');
        ops.innerHTML=sec('Operations',opsCards)+sec('Charges & collection',chargeCards);
        ops.querySelectorAll('.dpled-ocard').forEach(c=>c.addEventListener('click',()=>dpledDrill((c.dataset.st||'').split(',').filter(Boolean),c.dataset.pay)));
    }
    const th='px-3 py-2 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60 whitespace-nowrap',thl=th.replace('text-right','text-left');
    const td='px-3 py-2 text-sm text-slate-700 border-b border-slate-100 text-right tabular-nums whitespace-nowrap';
    const dash='<span class="text-slate-300">—</span>';
    const body=rows.map(m=>{ const bigVar=m.variance!=null&&Math.abs(m.variance)>Math.max(0.05*(m.expCharges||0),100);
        const varTxt=m.variance==null?dash:`<span class="${Math.abs(m.variance)<1?'text-slate-400':m.variance>0?'text-rose-600':'text-emerald-600'}" title="${bigVar?'Material variance — DocPharma invoiced differs from rate-card expectation':''}">${bigVar?'⚠ ':''}${m.variance>0?'+':''}${OPS_INR(Math.round(m.variance))}</span>`;
        const open=!!_dpledOpen[m.month], car=`<span class="inline-block w-3 text-slate-400">${open?'▾':'▸'}</span>`;
        const R=v=>OPS_INR(Math.round(v||0));
        const li=(l,v,c,strong)=>`<div class="flex items-center justify-between gap-3 py-1 text-xs ${strong?'border-t border-slate-200 mt-1 pt-1.5':''}"><span class="${strong?'font-semibold text-slate-700':'text-slate-500'}">${l}</span><span class="font-semibold ${c||'text-slate-700'} tabular-nums whitespace-nowrap">${v}</span></div>`;
        const hd=t=>`<div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">${t}</div>`;
        const rate=_dpledRate||{}, gst=Math.round((m.expCharges||0)*0.18), svc=(m.delivered||0)+(m.rto||0);
        const rateN=v=>v?`${R(v)}`:'₹0';
        const col1=hd('Fulfilment')
            +li('Delivered',`${m.delivered||0} orders`,'text-emerald-700')
            +li('· COD delivered',`${m.codOrders||0}`)
            +li('· Prepaid delivered',`${m.prepaidOrders||0}`)
            +li('RTO',`${m.rto||0}`,'text-rose-600')
            +li('· COD RTO',`${m.rtoCod||0}`)
            +li('· Prepaid RTO',`${m.rtoPrepaid||0}`)
            +li('Lost',`${m.lost||0}`,m.lost?'text-rose-600':'text-slate-400')
            +li('Rejected / Cancelled',`${m.rejected||0}`,m.rejected?'text-slate-500':'text-slate-400')
            +li('Total orders',`${m.totalOrders||0}`,'text-slate-800',true);
        const col2=hd('Expected charges (payable)')
            +li(`Flat service · ${svc}×${rateN(rate.flat_service_charge)}`,R(m.expService),'text-indigo-600')
            +li(`RTO · ${m.rto||0}×${rateN(rate.rto_charge)}`,R(m.expRto),'text-rose-600')
            +li(`COD fee · ${m.codOrders||0}×${rateN(rate.cod_collection_charge)}`,R(m.expCod),'text-sky-600')
            +li('Subtotal (rate card)',R(m.expCharges),'text-slate-800',true)
            +li('Est. GST 18%',R(gst),'text-slate-400')
            +li('Est. total incl GST',R((m.expCharges||0)+gst),'text-slate-800')
            +(m.invoices?li('Invoiced (actual, incl tax)',R(m.invGrand||m.invCharges||0),'text-red-600')+(m.variance!=null?li('Variance vs expected',`${m.variance>0?'+':''}${R(m.variance)}`,Math.abs(m.variance)<1?'text-slate-400':m.variance>0?'text-rose-600':'text-emerald-600'):''):li('Invoiced','not yet billed','text-slate-400'));
        const payExp=Math.round((m.expCharges||0)*1.18), outInv=m.outstanding, outExp=(m.receivable||0)-payExp-(m.paidNet||0);
        const oc=v=>v>0?'text-amber-600':v<0?'text-rose-600':'text-slate-400';
        const col3=hd('Receivable & settlement')
            +li('COD collected',`+ ${R(m.codCollected)}`,'text-emerald-700')
            +(m.lostComp?li(`Lost compensation (${m.lost||0})`,`+ ${R(m.lostComp)}`,'text-emerald-700'):'')
            +li('Prepaid delivered (memo)',R(m.prepaidValue||0),'text-slate-400')
            +li('Receivable',R(m.receivable),'text-emerald-700',true)
            +li('− Paid (FIFO)',R(m.paidNet||0),'text-emerald-700')
            +`<div class="border-t-2 border-slate-200 mt-1.5 pt-1.5"><div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Outstanding — both scenarios</div></div>`
            +li(m.invoices?`Billed · payable ${R(m.invGrand||0)}`:'Not billed yet · payable ₹0',R(outInv),oc(outInv))
            +li(`If billed @ rate card · est ${R(payExp)}`,R(outExp),oc(outExp))
            +`<div class="mt-2">${m.settled==='na'?'':`<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${(DPLED_SETTLE[m.settled]||DPLED_SETTLE.na)[1]}">${(DPLED_SETTLE[m.settled]||DPLED_SETTLE.na)[0]}</span>`}</div>`;
        const det=open?`<tr class="dpled-det ec-fade bg-slate-50/60"><td colspan="14" class="px-8 py-4 border-b border-slate-100"><div class="grid grid-cols-1 md:grid-cols-3 gap-x-10 gap-y-1 max-w-4xl">
            <div>${col1}</div><div>${col2}</div><div>${col3}</div></div></td></tr>`:'';
        return `<tr class="dpled-row hover:bg-slate-50 cursor-pointer" data-m="${m.month}"><td class="${td} text-left font-semibold">${car} ${dpledMonLabel(m.month)}</td><td class="${td} font-semibold text-slate-700">${(m.totalOrders||0).toLocaleString('en-IN')}</td><td class="${td}">${m.delivered}</td><td class="${td}">${m.rto}</td><td class="${td}">${m.rejected?`<span class="text-slate-500">${m.rejected}</span>`:'<span class="text-slate-300">0</span>'}</td><td class="${td}">${OPS_INR(Math.round(m.expCharges))}</td><td class="${td}">${m.invoices?OPS_INR(Math.round(m.invCharges)):dash}</td><td class="${td}">${varTxt}</td><td class="${td} text-emerald-700">${OPS_INR(Math.round(m.codCollected))}</td><td class="${td}">${m.lostComp?`<span class="text-emerald-700">${OPS_INR(Math.round(m.lostComp))}</span>${m.lost?` <span class="text-slate-400">(${m.lost})</span>`:''}`:dash}</td><td class="${td}">${OPS_INR(Math.round(m.remitExpected))}</td><td class="${td} text-emerald-700">${m.paidNet?OPS_INR(Math.round(m.paidNet)):dash}</td><td class="${td} text-center">${m.settled==='na'?dash:`<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${(DPLED_SETTLE[m.settled]||DPLED_SETTLE.na)[1]}">${(DPLED_SETTLE[m.settled]||DPLED_SETTLE.na)[0]}</span>`}</td><td class="${td} font-bold ${m.outstanding>0?'text-amber-600':m.outstanding<0?'text-rose-600':'text-slate-400'}">${OPS_INR(Math.round(m.outstanding))}</td></tr>${det}`;}).join('');
    document.getElementById('dpled-table').innerHTML=`<table class="w-full border-collapse"><thead><tr><th class="${thl}">Month</th><th class="${th}">Total</th><th class="${th}">Deliv</th><th class="${th}">RTO</th><th class="${th}">Rej</th><th class="${th}">Exp charges</th><th class="${th}">Invoiced</th><th class="${th}">Variance</th><th class="${th}">COD collected</th><th class="${th}">Lost comp</th><th class="${th}">Net remit</th><th class="${th}">Paid (FIFO)</th><th class="${th} text-center">Status</th><th class="${th}">Outstanding</th></tr></thead><tbody>${body||'<tr><td colspan="14" class="p-6 text-center text-xs text-slate-400">No data</td></tr>'}</tbody></table>`;
    document.querySelectorAll('#dpled-table .dpled-row').forEach(tr=>tr.addEventListener('click',()=>{ const mk=tr.getAttribute('data-m'); _dpledOpen[mk]=!_dpledOpen[mk]; dpledRender(); }));
}

// ─── DocPharma Payments tab ─────────────────────────────────────────────────
let _dprePayWired=false;
function dprePayInit(){ const sec=document.getElementById('dpre-tab-payments'); if(!sec)return;
    if(!_dprePayWired){ sec.innerHTML=`<div class="p-6 space-y-5">
        <div class="card p-0 overflow-hidden"><div class="flex items-center justify-between px-5 py-3 border-b border-slate-100"><h2 class="text-sm font-bold text-slate-700">Payments <span class="text-slate-400 font-normal">· remittances from DocPharma</span></h2><button id="dppay-add" class="text-xs px-3 py-1.5 bg-slate-800 text-white rounded-lg">＋ Record payment</button></div><div id="dppay-list" class="overflow-x-auto"></div></div>
      </div>
      <div id="dppay-modal" class="fixed inset-0 z-50 hidden items-center justify-center" style="background:rgba(15,23,42,.45)"><div id="dppay-box" class="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 mx-4" onclick="event.stopPropagation()"></div></div>`;
        sec.querySelector('#dppay-add').addEventListener('click',()=>dprePayForm());
        sec.querySelector('#dppay-modal').addEventListener('click',()=>{ const m=document.getElementById('dppay-modal'); m.classList.add('hidden'); m.classList.remove('flex'); });
        _dprePayWired=true;
    }
    dprePayLoad();
}
async function dprePayLoad(){ const el=document.getElementById('dppay-list'); if(!el)return; el.innerHTML='<div class="p-4 text-xs text-slate-400">Loading…</div>';
    try{ const r=await fetch('/api/docpharma-payments',{headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        const ps=d.payments||[]; if(!ps.length){ el.innerHTML='<div class="p-6 text-center text-xs text-slate-400">No payments recorded yet.</div>'; return; }
        const th='px-3 py-2 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 bg-slate-50/60',td='px-3 py-2 text-sm text-slate-700 border-b border-slate-100';
        el.innerHTML=`<table class="w-full"><thead><tr><th class="${th}">Date</th><th class="${th}">Direction</th><th class="${th} text-right">Amount</th><th class="${th}">Reference</th><th class="${th}">Period</th><th class="${th}">Notes</th><th class="${th}"></th></tr></thead><tbody>${ps.map(p=>`<tr class="hover:bg-slate-50"><td class="${td} tabular-nums">${dpreDMY(p.payment_date)||'—'}</td><td class="${td}"><span class="px-2 py-0.5 rounded-full text-[11px] font-medium ${p.direction==='paid'?'bg-rose-100 text-rose-700':'bg-emerald-100 text-emerald-700'}">${p.direction==='paid'?'Paid out':'Received'}</span></td><td class="${td} text-right tabular-nums font-semibold">${OPS_INR(p.amount||0)}</td><td class="${td}">${p.reference||'—'}</td><td class="${td} text-slate-500">${p.period_from?dpreDMY(p.period_from):'—'}</td><td class="${td} text-slate-500">${p.notes||''}</td><td class="${td} text-right"><button class="dppay-del text-rose-500 text-xs" data-id="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table>`;
        el.querySelectorAll('.dppay-del').forEach(b=>b.addEventListener('click',()=>dprePayDelete(b.dataset.id)));
    }catch(e){ el.innerHTML='<div class="p-4 text-xs text-rose-500">'+e.message+'</div>'; }
}
function dprePayForm(){ const box=document.getElementById('dppay-box'); const f=(l,id,v,t)=>`<div><label class="block text-[11px] text-slate-500 mb-0.5">${l}</label><input id="${id}" type="${t||'text'}" value="${v||''}" class="${DPINV_IN} w-full"></div>`;
    box.innerHTML=`<div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-slate-800">Record payment</h3><button id="dppay-x" class="text-slate-400 text-xl">✕</button></div>
      <div class="grid grid-cols-2 gap-3 mb-3">${f('Date','pp-date','','date')}<div><label class="block text-[11px] text-slate-500 mb-0.5">Direction</label><select id="pp-dir" class="${DPINV_IN} w-full"><option value="received">Received from DocPharma</option><option value="paid">Paid to DocPharma</option></select></div>${f('Amount (₹)','pp-amt','','number')}${f('Reference / UTR','pp-ref')}${f('Period from','pp-pf','','date')}${f('Period to','pp-pt','','date')}${f('Notes','pp-notes')}</div>
      <div class="flex justify-end gap-2"><button id="dppay-cancel" class="px-4 py-2 text-sm text-slate-600">Cancel</button><button id="dppay-save" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg">Save</button></div>`;
    const close=()=>{ const m=document.getElementById('dppay-modal'); m.classList.add('hidden'); m.classList.remove('flex'); };
    box.querySelector('#dppay-x').addEventListener('click',close); box.querySelector('#dppay-cancel').addEventListener('click',close);
    box.querySelector('#dppay-save').addEventListener('click',()=>dprePaySave());
    const m=document.getElementById('dppay-modal'); m.classList.remove('hidden'); m.classList.add('flex');
}
async function dprePaySave(){ const g=id=>document.getElementById(id).value;
    const body={ payment_date:g('pp-date')||null, direction:g('pp-dir'), amount:g('pp-amt'), reference:g('pp-ref'), period_from:g('pp-pf')||null, period_to:g('pp-pt')||null, notes:g('pp-notes') };
    if(!body.payment_date||!body.amount){ showNotification('Date and amount required',true); return; }
    try{ const r=await fetch('/api/docpharma-payments',{method:'POST',headers:{'Content-Type':'application/json',...getAuthHeaders()},body:JSON.stringify(body)}); const d=await r.json(); if(!d.success)throw new Error(d.error);
        showNotification('Payment saved'); const m=document.getElementById('dppay-modal'); m.classList.add('hidden'); m.classList.remove('flex'); dprePayLoad();
    }catch(e){ showNotification('Save failed: '+e.message,true); }
}
async function dprePayDelete(id){ if(!confirm('Delete this payment?'))return;
    try{ const r=await fetch('/api/docpharma-payments/'+id,{method:'DELETE',headers:getAuthHeaders()}); const d=await r.json(); if(!d.success)throw new Error(d.error); showNotification('Deleted'); dprePayLoad(); }
    catch(e){ showNotification('Delete failed: '+e.message,true); }
}

// ─── Delivery Performance (RTO / NDR / FASR) ─────────────────────────────────
let _dpFrom = null, _dpTo = null, _dpData = null, _dpWired = false, _dpSource = 'all', _dpPayment = 'all', _dpZone = [], _dpState = [], _dpCourier = 'all', _dpOrderType = 'all', _dpCompare = false, _dpTatFilter = null;
// Order→Dispatch TAT buckets (must mirror BUCKETS_HRS in delivery_reports.js). [borderColor, rowTint].
const DP_TAT_BUCKETS = [
  { label: '0-12',  max: 12,       color: '#22c55e', tint: '#f0fdf4' },
  { label: '12-24', max: 24,       color: '#0ea5e9', tint: '#f0f9ff' },
  { label: '24-36', max: 36,       color: '#f59e0b', tint: '#fffbeb' },
  { label: '36-48', max: 48,       color: '#f97316', tint: '#fff7ed' },
  { label: '48+',   max: Infinity, color: '#ef4444', tint: '#fef2f2' },
];
function dpOtdBucket(h){ if(h==null||isNaN(h)) return -1; for(let i=0;i<DP_TAT_BUCKETS.length;i++) if(h<=DP_TAT_BUCKETS[i].max) return i; return DP_TAT_BUCKETS.length-1; }
// Shipment table sort + click-to-expand detail state.
let _dpSort={key:'order_date',dir:'desc'}, _dpOpenAwb=null; const _dpScanCache={};
// Format an ISO timestamp as "27 Jun, 2:04 PM" (local). '—' if missing.
function dpFmtTs(iso){ if(!iso) return '—'; const d=new Date(iso); if(isNaN(d)) return '—';
  return d.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'numeric',minute:'2-digit',hour12:true}); }
// "2026-06-23" → "23 Jun" (compact, no wrap).
const DP_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dpShortDate(ymd){ if(!ymd) return '—'; const p=String(ymd).split('-'); if(p.length<3) return ymd; return `${+p[2]} ${DP_MON[(+p[1])-1]||''}`; }
function dpSortVal(r,key){ switch(key){
  case 'attempts': return r.attempts||0; case 'ndr_count': return r.ndr_count||0;
  case 'otdHrs': return r.otdHrs==null?-1:r.otdHrs;
  case 'order_date': return r.ts&&r.ts.order?r.ts.order:'';
  case 'order': return (r.order||'').toLowerCase(); case 'state': return r.state||'';
  case 'courier': return (r.courier||'').toLowerCase(); case 'zone': return r.zone||'';
  case 'type': return r.order_type||''; default: return ''; } }
function dpDaysAgo(d){ const t=new Date(); t.setDate(t.getDate()-d); return t.toISOString().slice(0,10); }
function dpPresetRange(preset){
    const iso=d=>d.toISOString().slice(0,10), today=new Date();
    if(preset==='this-week'){ const dow=(today.getDay()+6)%7; const mon=new Date(); mon.setDate(today.getDate()-dow); return { from:iso(mon), to:iso(today) }; } // Mon→today
    const n=parseInt(preset,10)||30; const from=new Date(); from.setDate(today.getDate()-(n-1)); return { from:iso(from), to:iso(today) };
}
function dpInit(){
    if(!_dpFrom){ _dpFrom = dpDaysAgo(30); _dpTo = new Date().toISOString().slice(0,10); }
    const fEl=document.getElementById('dp-from'), tEl=document.getElementById('dp-to');
    if(fEl) fEl.value=_dpFrom; if(tEl) tEl.value=_dpTo;
    if(!_dpWired){
        _dpWired = true;
        document.getElementById('dp-range-preset')?.addEventListener('change', e=>{
            const v=e.target.value, cust=document.getElementById('dp-custom');
            cust.classList.toggle('hidden', v!=='custom'); cust.classList.toggle('flex', v==='custom');
            if(v==='custom') return; // wait for Apply
            const r=dpPresetRange(v); _dpFrom=r.from; _dpTo=r.to;
            document.getElementById('dp-from').value=_dpFrom; document.getElementById('dp-to').value=_dpTo; dpLoad(); });
        document.getElementById('dp-apply')?.addEventListener('click', ()=>{ _dpFrom=document.getElementById('dp-from').value; _dpTo=document.getElementById('dp-to').value; dpLoad(); });
        document.getElementById('dp-source')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return;
            [...b.parentElement.children].forEach(x=>{ x.classList.remove('bg-indigo-600','text-white'); x.classList.add('text-slate-600'); });
            b.classList.add('bg-indigo-600','text-white'); b.classList.remove('text-slate-600');
            _dpSource=b.dataset.s; dpLoad(); });
        document.getElementById('dp-payment')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return;
            [...b.parentElement.children].forEach(x=>{ x.classList.remove('bg-indigo-600','text-white'); x.classList.add('text-slate-600'); });
            b.classList.add('bg-indigo-600','text-white'); b.classList.remove('text-slate-600');
            _dpPayment=b.dataset.p; dpLoad(); });
        // Zone + State multi-select dropdowns (checkbox panels).
        [['dp-zone-multi','zone'],['dp-geostate-multi','state']].forEach(([wrapId,key])=>{
            const wrap=document.getElementById(wrapId); if(!wrap) return;
            const btn=wrap.querySelector('.dp-multi-btn'), panel=wrap.querySelector('.dp-multi-panel');
            const arr=()=>key==='zone'?_dpZone:_dpState;
            btn.addEventListener('click',e=>{ e.stopPropagation(); const wasOpen=!panel.classList.contains('hidden');
                document.querySelectorAll('#delivery-perf-view .dp-multi-panel').forEach(p=>p.classList.add('hidden'));
                if(!wasOpen){ panel.classList.remove('hidden'); panel.querySelector('.dp-multi-search')?.focus(); } });
            panel.addEventListener('click',e=>{ e.stopPropagation();
                if(e.target.classList.contains('dp-multi-clear')){ arr().length=0; dpLoad(); }
                else if(e.target.classList.contains('dp-multi-all')){   // select all VISIBLE (respects the search filter)
                    const a=arr();
                    [...panel.querySelectorAll('.dp-multi-item')].filter(it=>it.style.display!=='none')
                        .forEach(it=>{ const v=it.querySelector('input').value; if(!a.includes(v)) a.push(v); });
                    dpLoad();
                } });
            panel.addEventListener('change',e=>{ if(e.target.type!=='checkbox') return; const a=arr(), v=e.target.value, i=a.indexOf(v);
                if(e.target.checked){ if(i<0) a.push(v); } else if(i>=0) a.splice(i,1); dpLoad(); });
            panel.addEventListener('input',e=>{ if(!e.target.classList.contains('dp-multi-search')) return;
                _dpMultiSearch[key]=e.target.value; dpMultiFilter(panel, e.target.value); });
        });
        document.addEventListener('click',()=>document.querySelectorAll('#delivery-perf-view .dp-multi-panel').forEach(p=>p.classList.add('hidden')));
        document.getElementById('dp-courier-filter')?.addEventListener('change', e=>{ _dpCourier=e.target.value; dpTableRender(); });
        document.getElementById('dp-ordertype')?.addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return;
            [...b.parentElement.children].forEach(x=>{ x.classList.remove('bg-indigo-600','text-white'); x.classList.add('text-slate-600'); });
            b.classList.add('bg-indigo-600','text-white'); b.classList.remove('text-slate-600');
            _dpOrderType=b.dataset.o; dpLoad(); });
        document.getElementById('dp-state')?.addEventListener('change', ()=>dpTableRender());
        document.getElementById('dp-search')?.addEventListener('input', ()=>dpTableRender());
    }
    dpLoad();
}
async function dpLoad(){
    const kpi=document.getElementById('dp-kpis'); if(kpi) kpi.innerHTML='<div class="text-slate-400 text-sm p-6">Loading delivery data…</div>';
    try{
        const r=await fetch(`/api/delivery-performance?from=${_dpFrom}&to=${_dpTo}&source=${_dpSource}&payment=${_dpPayment}&zone=${encodeURIComponent(_dpZone.join(','))}&state=${encodeURIComponent(_dpState.join(','))}&order_type=${_dpOrderType}&compare=1`, { headers: getAuthHeaders() });
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _dpData=d; dpRender(d);
    }catch(e){ if(kpi) kpi.innerHTML='<div class="text-red-500 text-sm p-6">Error: '+e.message+'</div>'; }
}
const DP_ICONS={
  bolt:'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>',
  refresh:'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>',
  uturn:'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h11a4 4 0 010 8h-1M3 10l4-4M3 10l4 4"/></svg>',
  hash:'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"/></svg>'
};
// Δ pill vs the previous period. Literal direction colouring: ▲ up = green, ▼ down = red.
function dpDelta(cur,prev,higherBetter,unit){ if(prev==null) return '';
    const diff=Math.round((cur-prev)*10)/10;
    if(diff===0) return `<span class="inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-semibold bg-slate-100 text-slate-400">—</span>`;
    const up=diff>0, cls=up?'bg-emerald-50 text-emerald-700':'bg-rose-50 text-rose-700';
    return `<span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-lg text-xs font-bold ${cls}" title="vs ${prev}${unit} previous period">${up?'▲':'▼'} ${Math.abs(diff)}${unit}</span>`;
}
// Tiny inline pp-delta for chips (▲ up = green / ▼ down = red, literal). cur/prev are share %.
function dpPP(cur,prev){ if(prev==null||!isFinite(prev)||!isFinite(cur)) return ''; const d=Math.round((cur-prev)*10)/10; if(d===0) return '';
    const up=d>0; return `<span class="text-[10px] font-bold ml-1 ${up?'text-emerald-600':'text-rose-600'}" title="${prev}pp prev">${up?'▲':'▼'}${Math.abs(d)}</span>`; }
// Numeric delta for TAT averages (with unit suffix).
function dpNumDelta(cur,prev,unit){ if(prev==null||!isFinite(prev)||!isFinite(cur)) return '';
    const d=Math.round((cur-prev)*100)/100, up=d>0;
    if(d===0) return `<div class="text-[11px] text-slate-400 mt-0.5">— vs ${prev}${unit} prev</div>`;
    return `<div class="text-[11px] font-bold mt-0.5 ${up?'text-emerald-600':'text-rose-600'}">${up?'▲':'▼'} ${Math.abs(d)}${unit} <span class="text-slate-400 font-normal">vs ${prev}${unit} prev</span></div>`; }
function dpKpiCard(cfg){
    const hasPrev = cfg.prev!=null;
    return `<div class="dp-kpi card p-5" style="--accent:${cfg.accent}">
        <div class="flex items-start justify-between">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:${cfg.tint};color:${cfg.accent}">${cfg.icon}</div>
          ${hasPrev?dpDelta(cfg.cur,cfg.prev,cfg.better,cfg.unit):''}
        </div>
        <div class="text-[2rem] leading-none font-extrabold text-slate-800 tracking-tight tabular-nums mt-4">${cfg.val}</div>
        <div class="text-sm font-semibold text-slate-600 mt-1.5">${cfg.label}</div>
        <div class="text-xs text-slate-400 mt-0.5">${cfg.foot}</div>
        ${hasPrev?`<div class="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-100">vs <span class="tabular-nums">${cfg.prev}${cfg.unit}</span> previous period</div>`:''}
    </div>`;
}
function dpRender(d){
    const k=d.kpis, c=d.compare&&d.compare.kpis;
    document.getElementById('dp-range').textContent=`${d.range.from} → ${d.range.to} · ${k.totalShipments} tracked = ${k.resolved} shipped (delivered+RTO) + ${k.pending} NDR-pending + ${k.inTransit} in-transit${k.lost?` + ${k.lost} lost`:''}`+(c?`  ·  vs prev ${d.compare.range.from} → ${d.compare.range.to} (${c.totalShipments} tracked)`:'');
    document.getElementById('dp-kpis').innerHTML = [
        {label:'First-Attempt Strike Rate', accent:'#4f46e5', tint:'#eef2ff', icon:DP_ICONS.bolt,   val:k.fasr+'%',            foot:`${k.fasrNumerator} of ${k.totalShipments} tracked on 1st attempt`, cur:k.fasr,            prev:c?c.fasr:null,            better:true,  unit:'pp'},
        {label:'NDR Recovery',            accent:'#059669', tint:'#ecfdf5', icon:DP_ICONS.refresh, val:k.ndrRecoveryRate+'%', foot:`${k.ndrRecovered} of ${k.ndrTotal} NDRs recovered`,      cur:k.ndrRecoveryRate, prev:c?c.ndrRecoveryRate:null, better:true,  unit:'pp'},
        {label:'RTO Rate',                accent:'#e11d48', tint:'#fff1f2', icon:DP_ICONS.uturn,   val:k.rtoRate+'%',         foot:`${k.rto} of ${k.totalShipments} returned`,               cur:k.rtoRate,         prev:c?c.rtoRate:null,         better:false, unit:'pp'},
        {label:'Avg Delivery Attempts',   accent:'#0891b2', tint:'#ecfeff', icon:DP_ICONS.hash,    val:k.avgAttempts,         foot:`across ${k.resolved} resolved`,                          cur:k.avgAttempts,     prev:c?c.avgAttempts:null,     better:false, unit:''},
    ].map(dpKpiCard).join('');
    dpStatus(d.statusBreakdown, c);
    dpRto(d.rtoBreakdown, c);
    dpMulti('zone', d.zones); dpMulti('state', d.states); dpCouriers(d.couriers); dpTat(d.tat, c);
    dpFasr(d.fasrTrend); dpFunnel(d.ndrFunnel); dpCourier(d.rtoByCourier); dpTableRender();
}
// Populate the Zone dropdown from the window's zones (preserves current selection).
// Multi-select checkbox dropdown for Zone / State — with search + Select all / Clear all.
const _dpMultiSearch = { zone:'', state:'' };
function dpMulti(key, options){
    const cfg = key==='zone'
      ? { wrapId:'dp-zone-multi', sel:_dpZone, all:'All zones', word:'Zones', fmt:o=>`Zone ${o.zone}` }
      : { wrapId:'dp-geostate-multi', sel:_dpState, all:'All states', word:'States', fmt:o=>o.state };
    const wrap=document.getElementById(cfg.wrapId); if(!wrap) return;
    const btn=wrap.querySelector('.dp-multi-btn'), panel=wrap.querySelector('.dp-multi-panel');
    const opts=(options||[]).map(o=>({ v:String(key==='zone'?o.zone:o.state), l:cfg.fmt(o), c:o.count }));
    const valid=new Set(opts.map(o=>o.v)); for(let i=cfg.sel.length-1;i>=0;i--){ if(!valid.has(cfg.sel[i])) cfg.sel.splice(i,1); }
    btn.innerHTML = (cfg.sel.length===0 ? `<span class="text-slate-400">${cfg.all}</span>`
      : cfg.sel.length===1 ? cfg.sel[0] : `${cfg.word}: ${cfg.sel.length}`) + ' <span class="text-slate-400">▾</span>';
    const items = opts.map(o=>`<label class="dp-multi-item" data-s="${o.l.toLowerCase().replace(/"/g,'&quot;')}"><input type="checkbox" value="${o.v.replace(/"/g,'&quot;')}" ${cfg.sel.includes(o.v)?'checked':''}><span class="flex-1">${o.l}</span><span class="dp-multi-count">${o.c}</span></label>`).join('');
    panel.innerHTML =
      `<div class="dp-multi-head">`+
        `<input type="text" class="dp-multi-search" placeholder="Search…" value="${_dpMultiSearch[key].replace(/"/g,'&quot;')}">`+
        `<div class="dp-multi-actions"><button type="button" class="dp-multi-all">Select all</button><button type="button" class="dp-multi-clear">Clear all</button></div>`+
      `</div>`+
      `<div class="dp-multi-list">${items||'<div class="px-3 py-2 text-xs text-slate-400">No options</div>'}</div>`;
    dpMultiFilter(panel, _dpMultiSearch[key]);
}
function dpMultiFilter(panel, term){ const t=String(term||'').trim().toLowerCase();
    panel.querySelectorAll('.dp-multi-item').forEach(it=>{ it.style.display=(!t||(it.dataset.s||'').includes(t))?'':'none'; }); }
// Populate the Courier dropdown from the window's couriers (preserves current selection).
function dpCouriers(couriers){ const sel=document.getElementById('dp-courier-filter'); if(!sel) return;
    const cur=_dpCourier;
    let html='<option value="all">All couriers</option>';
    (couriers||[]).forEach(c=>{ const nm=(c.courier||'').replace(/"/g,'&quot;'); html+=`<option value="${nm}">${c.courier} (${c.count})</option>`; });
    sel.innerHTML=html; sel.value=cur; if(sel.value!==cur){ _dpCourier='all'; sel.value='all'; }
}
// TAT Dashboard — two cards: Order→Dispatch and Dispatch→Delivery, avg + bucket bars (0-1/1-3/3-5/5+).
function dpTatCard(title,sub,t,prevAvg,filterable){ if(!t){ return ''; }
    const colors=['bg-green-500','bg-sky-500','bg-amber-500','bg-orange-500','bg-red-500'];
    const tot=t.count||0, suffix=t.unit==='hrs'?'h':'d', unitLbl=t.unit==='hrs'?'hrs':'days';
    const bars=(t.buckets||[]).map((b,i)=>{ const n=b.count||0, pctv=tot?Math.round(n/tot*100):0;
        const active=filterable && _dpTatFilter===i;
        // When filterable, each row is a clickable button that filters the shipment table to that bucket.
        const cls=filterable?`dp-tatbar w-full flex items-center gap-2 text-xs rounded-md px-1 py-0.5 -mx-1 cursor-pointer transition-colors ${active?'':'hover:bg-slate-50'}`:'flex items-center gap-2 text-xs';
        const style=active?`style="background:${DP_TAT_BUCKETS[i].tint};box-shadow:inset 0 0 0 2px ${DP_TAT_BUCKETS[i].color}"`:'';
        const tag=filterable?'button':'div';
        const attrs=filterable?`data-bucket="${i}" title="Click to show these ${n} shipments in the table"`:'';
        return `<${tag} type="button" class="${cls}" ${attrs} ${style}>
          <span class="w-14 text-slate-500 tabular-nums text-left">${b.label}${suffix}</span>
          <div class="flex-1 h-4 bg-slate-100 rounded overflow-hidden"><div class="${colors[i%colors.length]} h-4 rounded" style="width:${pctv}%"></div></div>
          <span class="w-16 text-right text-slate-600 tabular-nums">${n} · ${pctv}%</span>
        </${tag}>`; }).join('');
    const hint=filterable?`<span class="text-[10px] text-indigo-400 ml-1">${_dpTatFilter!=null?'· filtering — click again to clear':'· click a bucket to filter'}</span>`:'';
    return `<div class="card p-5">
        <div class="flex items-start justify-between"><h2 class="text-sm font-bold text-slate-700">${title}</h2>
          <div class="text-right"><div><span class="text-2xl font-bold text-slate-800 tabular-nums">${t.avg}</span><span class="text-xs text-slate-400 ml-1">avg ${unitLbl}</span></div>${dpNumDelta(t.avg,prevAvg,suffix)}</div></div>
        <p class="text-xs text-slate-400 mb-3">${sub} · ${tot} shipments${hint}</p>
        <div class="space-y-1.5">${bars}</div></div>`;
}
function dpTat(t,c){ const el=document.getElementById('dp-tat'); if(!el) return; if(!t){ el.innerHTML=''; return; }
    el.innerHTML =
        dpTatCard('Order → Dispatch TAT','Time from order to courier pickup', t.orderToDispatch, c?c.otdAvg:null, true)+
        dpTatCard('Dispatch → Delivery TAT','Courier transit time to delivery', t.dispatchToDelivery, c?c.dtdAvg:null);
    // Wire the Order→Dispatch buckets: toggle the TAT filter and refresh the table (colored by bucket).
    el.querySelectorAll('.dp-tatbar').forEach(b=>b.addEventListener('click',()=>{
        const i=+b.dataset.bucket; _dpTatFilter = (_dpTatFilter===i)?null:i;
        dpTat(t,c); dpTableRender();
        if(_dpTatFilter!=null) document.getElementById('dp-table')?.scrollIntoView({behavior:'smooth',block:'start'});
    }));
}
// Clickable partition chip — filters the shipment explorer to that state. Sums to `total`.
function dpStatusChip(dot,label,val,total,state,prevShare){ const p=total?Math.round(val/total*1000)/10:0;
    return `<button data-state="${state||''}" class="dp-chip inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg hover:border-indigo-400 transition-colors"><span class="w-2 h-2 rounded-full ${dot}"></span><span class="text-slate-500">${label}</span><b class="text-slate-800 tabular-nums">${val}</b><span class="text-slate-400 text-xs tabular-nums">${p}%</span>${dpPP(p,prevShare)}</button>`; }
function dpStatus(s,c){ const el=document.getElementById('dp-status'); if(!s){ el.innerHTML=''; return; }
    const t=s.total||0, pt=c?c.totalShipments:0;
    const ps=v=> (c&&pt&&v!=null)? Math.round(v/pt*1000)/10 : null;   // previous-period share %
    el.innerHTML =
        `<span class="inline-flex items-center px-3 py-1.5 bg-slate-800 text-white rounded-lg font-semibold tabular-nums">${t} tracked</span>`+
        dpStatusChip('bg-indigo-500','Delivered · 1st attempt', s.firstAttempt, t, 'delivered_first', ps(c&&c.firstAttempt))+
        dpStatusChip('bg-sky-500','Delivered · after NDR', s.deliveredMulti, t, 'delivered_ndr', ps(c&&c.deliveredMulti))+
        dpStatusChip('bg-red-500','RTO', s.rto, t, 'rto', ps(c&&c.rto))+
        (s.lost>0 ? dpStatusChip('bg-rose-800','Lost', s.lost, t, 'lost', ps(c&&c.lost)) : '')+
        dpStatusChip('bg-amber-500','NDR pending', s.ndrPending, t, 'ndr_pending', ps(c&&c.ndrPending))+
        dpStatusChip('bg-slate-400','In-transit', s.inTransit, t, 'in_transit', ps(c&&c.inTransit))+
        `<span class="inline-flex items-center gap-1 text-xs text-slate-400 ml-1">= sums to tracked</span>`;
    el.querySelectorAll('.dp-chip').forEach(b=>b.addEventListener('click',()=>{ const st=b.dataset.state||'all';
        const sel=document.getElementById('dp-state'); if(sel){ sel.value=st; } dpTableRender();
        document.getElementById('dp-table')?.scrollIntoView({behavior:'smooth',block:'start'}); }));
}
// RTO composition — total RTO = attempted-then-returned + silent (never attempted). Both drill into the explorer.
function dpRto(b,c){ const el=document.getElementById('dp-rto'); if(!el) return; if(!b||!b.total){ el.innerHTML=''; return; }
    const cShare=v=> Math.round(v/b.total*1000)/10;              // share of current RTO
    const pShare=v=> (c&&c.rto&&v!=null)? Math.round(v/c.rto*1000)/10 : null;
    const chip=(state,dot,label,val,cur,prev)=>`<button data-state="${state}" class="dp-rchip inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg hover:border-red-400 transition-colors"><span class="w-2 h-2 rounded-full ${dot}"></span><span class="text-slate-500">${label}</span><b class="text-slate-800 tabular-nums">${val}</b>${dpPP(cur,prev)}</button>`;
    el.innerHTML =
        `<span class="text-slate-500 mr-1">RTO <b class="text-slate-800">${b.total}</b> =</span>`+
        chip('rto_attempted','bg-red-500','after ≥1 attempt', b.attempted, cShare(b.attempted), pShare(c&&c.rtoAttempted))+
        `<span class="text-slate-400">+</span>`+
        chip('rto_silent','bg-rose-300','silent · no attempt', b.silent, cShare(b.silent), pShare(c&&c.rtoSilent));
    el.querySelectorAll('.dp-rchip').forEach(x=>x.addEventListener('click',()=>{ const sel=document.getElementById('dp-state'); if(sel) sel.value=x.dataset.state; dpTableRender();
        document.getElementById('dp-table')?.scrollIntoView({behavior:'smooth',block:'start'}); }));
}
function dpTip(){ let t=document.getElementById('dp-tip'); if(!t){ t=document.createElement('div'); t.id='dp-tip'; t.style.cssText='position:fixed;pointer-events:none;background:#0f172a;color:#fff;padding:5px 8px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .08s;z-index:60;white-space:nowrap'; document.body.appendChild(t);} return t; }
function dpShow(html,x,y){ const t=dpTip(); t.innerHTML=html; t.style.opacity=1; t.style.left=(x+12)+'px'; t.style.top=(y+12)+'px'; }
function dpHide(){ dpTip().style.opacity=0; }
function dpFasr(rows){ const el=document.getElementById('dp-fasr'); if(!rows||!rows.length){ el.innerHTML='<div class="text-slate-400 text-sm py-8 text-center">No data</div>'; return; }
    const W=640,H=220,p={l:32,r:14,t:12,b:26}, iw=W-p.l-p.r, ih=H-p.t-p.b;
    const xs=rows.map((_,i)=>p.l+(rows.length===1?iw/2:i/(rows.length-1)*iw)); const y=v=>p.t+ih-(v/100)*ih;
    let g=''; for(let t=0;t<=100;t+=25){ g+=`<line x1="${p.l}" y1="${y(t)}" x2="${W-p.r}" y2="${y(t)}" stroke="#e2e8f0"/><text x="${p.l-6}" y="${y(t)+3}" text-anchor="end" fill="#94a3b8" font-size="11">${t}</text>`; }
    const pts=rows.map((r,i)=>`${xs[i]},${y(r.fasr)}`).join(' ');
    const dots=rows.map((r,i)=>`<circle cx="${xs[i]}" cy="${y(r.fasr)}" r="4" fill="#4f46e5" data-i="${i}"/>`).join('');
    const step=Math.ceil(rows.length/7); const xl=rows.map((r,i)=>i%step===0?`<text x="${xs[i]}" y="${H-8}" text-anchor="middle" fill="#94a3b8" font-size="11">${r.date.slice(5)}</text>`:'').join('');
    // Weighted-average line = Σfirst / Σresolved — this equals the FASR card value (period average).
    const sumF=rows.reduce((a,r)=>a+(r.first||0),0), sumR=rows.reduce((a,r)=>a+(r.reached||0),0);
    const avg=sumR?Math.round(sumF/sumR*1000)/10:0; const ay=y(avg);
    const avgLine=`<line x1="${p.l}" y1="${ay}" x2="${W-p.r}" y2="${ay}" stroke="#4f46e5" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.6"/><text x="${W-p.r}" y="${ay-5}" text-anchor="end" fill="#4f46e5" font-size="11" font-weight="600">avg ${avg}%</text>`;
    el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%">${g}${avgLine}<polyline points="${pts}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round"/>${dots}${xl}</svg>`;
    el.querySelectorAll('circle').forEach(c=>{ c.addEventListener('mousemove',e=>{const r=rows[+c.dataset.i];dpShow(`<b>${r.date}</b> · FASR ${r.fasr}% (${r.first}/${r.reached})`,e.clientX,e.clientY);}); c.addEventListener('mouseleave',dpHide); });
}
function dpFunnel(f){ const el=document.getElementById('dp-funnel'); const total=f&&f.total||0;
    if(!total){ el.innerHTML='<div class="text-slate-400 text-sm py-8 text-center">No NDR shipments in range</div>'; return; }
    const seg=[['Recovered → Delivered',f.recovered,'#16a34a'],['Lost → RTO',f.lost,'#dc2626'],['Still pending',f.pending,'#d97706']];
    const W=380,BH=26; let bar='',x=0,rows='';
    seg.forEach(([lab,v,c])=>{ const w=v/total*W; if(w>0){ bar+=`<rect x="${x}" y="0" width="${Math.max(0,w-2)}" height="${BH}" rx="4" fill="${c}"/>`; x+=w; }
      rows+=`<div class="flex items-center gap-2 mt-2 text-sm text-slate-700"><span class="w-2.5 h-2.5 rounded-full" style="background:${c}"></span><span class="flex-1">${lab}</span><b>${v}</b><span class="text-slate-400">${Math.round(v/total*1000)/10}%</span></div>`; });
    // Reconcile the cohort's RTO (f.lost) to the dashboard's TOTAL RTO via "silent" RTOs (no failed attempt).
    const dr=f.directRto||0, totalRto=f.totalRto!=null?f.totalRto:(f.lost+dr);
    const recon = dr>0
      ? `<div class="text-xs text-slate-400 mt-3 leading-relaxed">${total} shipments had ≥1 failed delivery attempt.<br>RTO here (${f.lost}) + ${dr} silent RTO (returned with no delivery attempt) = <b class="text-slate-500">${totalRto} total RTO</b>.</div>`
      : `<div class="text-xs text-slate-400 mt-3">${total} shipments had ≥1 failed delivery attempt · all ${totalRto} RTO had an attempt.</div>`;
    el.innerHTML=`<svg viewBox="0 0 ${W} ${BH}" style="width:100%;height:26px">${bar}</svg><div class="mt-1">${rows}</div>${recon}`;
}
function dpCourier(rows){ const el=document.getElementById('dp-courier'); if(!rows||!rows.length){ el.innerHTML='<div class="text-slate-400 text-sm py-6 text-center">No data in range</div>'; return; }
    const max=Math.max(...rows.map(r=>r.rto),1);
    // Bar LENGTH = RTO volume; bar/figure COLOR = RTO-rate severity (green ok · amber watch · red high).
    const sev=rate=> rate>=25?{bar:'#ef4444',fig:'text-red-600',pill:'bg-red-50 text-red-600'}
                    : rate>=15?{bar:'#f59e0b',fig:'text-amber-600',pill:'bg-amber-50 text-amber-600'}
                    :          {bar:'#10b981',fig:'text-emerald-600',pill:'bg-emerald-50 text-emerald-600'};
    el.innerHTML =
      `<div class="flex items-center gap-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
         <span class="w-40 shrink-0">Courier</span><span class="flex-1">Returns</span><span class="w-24 text-right shrink-0">RTO&nbsp;rate</span>
       </div>`+
      rows.map((r,i)=>{ const w=Math.max(3, Math.round(r.rto/max*100)); const s=sev(r.rtoRate); const inside=w>=14;
        return `<div class="dp-cr flex items-center gap-3 py-1 px-1 -mx-1 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer" data-i="${i}" title="Filter dashboard to ${r.courier||''}">
          <div class="w-40 shrink-0 text-sm text-slate-700 truncate" title="${r.courier||''}">${r.courier||'—'}</div>
          <div class="flex-1 relative h-6 bg-slate-100 rounded-md overflow-hidden min-w-[56px]">
            <div class="absolute inset-y-0 left-0 rounded-md flex items-center justify-end pr-2 transition-all" style="width:${w}%;background:${s.bar}">${inside?`<span class="text-[11px] font-bold text-white tabular-nums">${r.rto}</span>`:''}</div>
            ${inside?'':`<span class="absolute inset-y-0 flex items-center text-[11px] font-bold text-slate-600 tabular-nums" style="left:calc(${w}% + 6px)">${r.rto}</span>`}
          </div>
          <div class="w-24 shrink-0 text-right leading-tight">
            <span class="inline-block px-1.5 py-0.5 rounded-md text-xs font-bold tabular-nums ${s.pill}">${r.rtoRate}%</span>
            <div class="text-[11px] text-slate-400 tabular-nums mt-0.5">of ${r.total}</div>
          </div>
        </div>`; }).join('');
    el.querySelectorAll('.dp-cr').forEach(rc=>{ rc.addEventListener('mousemove',e=>{const r=rows[+rc.dataset.i];dpShow(`<b>${r.courier}</b> · ${r.rto} RTO of ${r.total} (${r.rtoRate}%)`,e.clientX,e.clientY);}); rc.addEventListener('mouseleave',dpHide);
        rc.addEventListener('click',()=>{ const r=rows[+rc.dataset.i]; if(!r||!r.courier) return; _dpCourier=r.courier; const sel=document.getElementById('dp-courier-filter'); if(sel) sel.value=r.courier; dpHide(); dpTableRender();
            document.getElementById('dp-table')?.scrollIntoView({behavior:'smooth',block:'start'}); }); });
}
const DP_STATE_BADGE={
    delivered_first:['Delivered · 1st','bg-indigo-100 text-indigo-700'],
    delivered_ndr:['Delivered · after NDR','bg-sky-100 text-sky-700'],
    rto:['RTO','bg-red-100 text-red-700'],
    lost:['Lost','bg-rose-200 text-rose-800'],
    ndr_pending:['NDR pending','bg-amber-100 text-amber-700'],
    in_transit:['In-transit','bg-slate-100 text-slate-600'],
};
// Powerful shipment explorer — filter by state (or NDR cohort) + free-text search over order/AWB.
function dpTableRender(){ const c=document.getElementById('dp-table'); const d=_dpData; if(!d||!c) return;
    const all=d.shipments||[];
    const state=document.getElementById('dp-state')?.value||'all';
    const q=(document.getElementById('dp-search')?.value||'').trim().toLowerCase();
    let list=all;
    if(state==='ndr_cohort') list=list.filter(r=>(r.ndr_count||0)>0);
    else if(state==='rto_attempted') list=list.filter(r=>r.state==='rto' && (r.ndr_count||0)>0);
    else if(state==='rto_silent') list=list.filter(r=>r.state==='rto' && (r.ndr_count||0)===0);
    else if(state!=='all') list=list.filter(r=>r.state===state);
    if(_dpCourier!=='all') list=list.filter(r=>(r.courier||'Unknown')===_dpCourier);
    if(_dpTatFilter!=null) list=list.filter(r=>dpOtdBucket(r.otdHrs)===_dpTatFilter);   // Order→Dispatch TAT bucket
    if(q) list=list.filter(r=>(r.order||'').toLowerCase().includes(q)||(r.awb||'').toLowerCase().includes(q));
    const cnt=document.getElementById('dp-count');
    if(cnt) cnt.textContent=`${list.length} shown${_dpTatFilter!=null?` · O→Dispatch ${DP_TAT_BUCKETS[_dpTatFilter].label}h`:''}${d.shipmentsTruncated?` · list capped at ${all.length} of ${d.shipmentsTotal}`:''}`;
    if(!list.length){ c.innerHTML='<div class="text-slate-400 text-sm p-6">No shipments match this filter</div>'; return; }
    // ── sort (click a header to change) ──
    const dir=_dpSort.dir==='asc'?1:-1;
    list=list.slice().sort((a,b)=>{ const va=dpSortVal(a,_dpSort.key), vb=dpSortVal(b,_dpSort.key); return va<vb?-dir:va>vb?dir:0; });
    const th='px-3 py-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap bg-slate-50/60';
    const td='px-3 py-2.5 text-sm text-slate-700 border-b border-slate-100 align-middle whitespace-nowrap';
    const cols=[{k:'order',l:'Order / AWB'},{k:'state',l:'State'},{k:'type',l:'Type'},{k:'courier',l:'Courier'},
        {k:'attempts',l:'Att',a:1},{k:'ndr_count',l:'NDR',a:1},{k:null,l:'Pay'},{k:null,l:'Zone',c:1},
        {k:'order_date',l:'Ordered'},{k:'otdHrs',l:'O→Disp'},{k:null,l:'NDR reasons'}];
    const head=cols.map(col=>{ const al=col.a?' text-right':col.c?' text-center':'';
        if(!col.k) return `<th class="${th}${al}">${col.l}</th>`;
        const act=_dpSort.key===col.k;
        const arrow=act?`<span class="text-indigo-500">${_dpSort.dir==='asc'?'↑':'↓'}</span>`:'<span class="text-slate-300 opacity-0 group-hover:opacity-100">↕</span>';
        return `<th class="${th}${al} dp-sort group cursor-pointer select-none hover:text-slate-600 ${act?'text-slate-600':''}" data-k="${col.k}">${col.l} ${arrow}</th>`; }).join('');
    const rows=list.slice(0,500).map(r=>{ const b=DP_STATE_BADGE[r.state]||['—','bg-slate-100 text-slate-600'];
        // TAT bucket drives ONLY a slim left accent stripe + a soft-tint pill (keeps rows clean, not loud).
        const bi=dpOtdBucket(r.otdHrs), bk=bi>=0?DP_TAT_BUCKETS[bi]:null, open=r.awb===_dpOpenAwb;
        const rowCls=open?'bg-indigo-50/70':'hover:bg-slate-50';
        const stripe=`box-shadow:inset 3px 0 0 ${bk?bk.color:'transparent'}`;
        const otdCell=bk?`<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tabular-nums" style="background:${bk.color}1f;color:${bk.color}">${Math.round(r.otdHrs)}h<span class="font-normal opacity-70">${bk.label}</span></span>`:'<span class="text-slate-300">—</span>';
        const pay=r.payment?`<span class="px-1.5 py-0.5 rounded text-[11px] font-medium ${/cod/i.test(r.payment)?'bg-orange-100 text-orange-700':'bg-emerald-100 text-emerald-700'}">${/cod/i.test(r.payment)?'COD':'Prepaid'}</span>`:'<span class="text-slate-300">—</span>';
        const typ=r.order_type==='repeat'?'<span class="px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-100 text-violet-700">Repeat</span>':r.order_type==='new'?'<span class="px-1.5 py-0.5 rounded text-[11px] font-medium bg-blue-100 text-blue-700">New</span>':'<span class="text-slate-300">—</span>';
        const reasons=(r.reasons||[]).join(' · ');
        let out=`<tr class="dp-row cursor-pointer transition-colors ${rowCls}" data-awb="${r.awb||''}">`+
          `<td class="${td}" style="${stripe}"><div class="flex items-center gap-1.5"><span class="text-slate-300 text-xs w-3">${open?'▾':'▸'}</span><div><div class="font-semibold text-slate-800 leading-tight">${r.order||'—'}${r.source==='docpharma'?'<span class="text-slate-400 text-[10px] font-normal ml-1">DP</span>':''}</div><div class="text-[11px] text-slate-400 leading-tight">${r.awb||''}</div></div></div></td>`+
          `<td class="${td}"><span class="px-2 py-0.5 rounded-full text-[11px] font-medium ${b[1]}">${b[0]}</span></td>`+
          `<td class="${td}">${typ}</td>`+
          `<td class="${td} text-slate-600"><div class="truncate max-w-[130px]" title="${r.courier||''}">${r.courier||'—'}</div></td>`+
          `<td class="${td} text-right tabular-nums ${r.attempts>1?'text-slate-800 font-medium':'text-slate-400'}">${r.attempts}</td>`+
          `<td class="${td} text-right tabular-nums ${r.ndr_count>0?'text-rose-600 font-medium':'text-slate-400'}">${r.ndr_count}</td>`+
          `<td class="${td}">${pay}</td>`+
          `<td class="${td} text-center text-slate-500 font-medium">${r.zone||'<span class="text-slate-300">—</span>'}</td>`+
          `<td class="${td} text-slate-500 tabular-nums">${dpShortDate(r.order_date)}</td>`+
          `<td class="${td}">${otdCell}</td>`+
          `<td class="px-3 py-2.5 text-sm border-b border-slate-100 align-middle"><div class="truncate max-w-[240px] text-xs text-slate-500" title="${reasons.replace(/"/g,'&quot;')}">${reasons||'—'}</div></td>`+
        `</tr>`;
        if(open) out+=dpRenderDetail(r,td);
        return out; }).join('');
    const more=list.length>500?`<div class="text-xs text-slate-400 p-3 text-center border-t border-slate-100">Showing first 500 of ${list.length} — narrow with search or filters</div>`:'';
    c.innerHTML=`<div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${more}`;
    c.querySelectorAll('.dp-sort').forEach(h=>h.addEventListener('click',()=>{ const k=h.dataset.k;
        if(_dpSort.key===k) _dpSort.dir=_dpSort.dir==='asc'?'desc':'asc';
        else _dpSort={key:k, dir:(['attempts','ndr_count','otdHrs','order_date'].includes(k)?'desc':'asc')};
        dpTableRender(); }));
    c.querySelectorAll('.dp-row').forEach(row=>row.addEventListener('click',()=>{ const awb=row.dataset.awb; if(!awb) return;
        _dpOpenAwb=(_dpOpenAwb===awb)?null:awb; dpTableRender();
        if(_dpOpenAwb && !_dpScanCache[awb]) dpLoadScans(awb); }));
}
// Expanded detail row — date-log (instant, from stored timeline) + scan-log (fetched on demand).
function dpRenderDetail(r,td){ const ts=r.ts||{};
    const step=(label,iso,color)=>{ const on=!!iso; return `<div class="flex items-center gap-2 py-0.5 text-xs"><span class="w-2 h-2 rounded-full shrink-0" style="background:${on?color:'#cbd5e1'}"></span><span class="w-28 text-slate-500">${label}</span><span class="tabular-nums ${on?'text-slate-700 font-medium':'text-slate-300'}">${dpFmtTs(iso)}</span></div>`; };
    const timeline=step('Order placed',ts.order,'#6366f1')+step('Picked up',ts.dispatched,'#0ea5e9')+
        step('Out for delivery',ts.ofd,'#f59e0b')+
        (r.state==='rto'?step('RTO',ts.rto,'#ef4444'):step('Delivered',ts.delivered,'#16a34a'))+
        step('Promised EDD',ts.edd,'#8b5cf6');
    const dest=[r.dest_city,r.dest_state].filter(Boolean).join(', ');
    const meta=`<div class="text-xs text-slate-500 mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <span>📍 Destination: <b class="text-slate-700">${dest||'—'}${r.dest_pincode?` · ${r.dest_pincode}`:''}</b>${r.zone?` <span class="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 font-semibold">Zone ${r.zone}</span>`:''}</span>
        <span>Status code: <b class="text-slate-700">${r.status_code||'—'}</b></span>
        <span>Attempts: <b class="text-slate-700">${r.attempts}</b></span>
        <span>NDRs: <b class="text-slate-700">${r.ndr_count}</b></span>
        ${r.otdHrs!=null?`<span>O→Dispatch: <b class="text-slate-700">${Math.round(r.otdHrs)}h</b></span>`:''}
        ${(r.reasons&&r.reasons.length)?`<span>Reasons: <b class="text-slate-700">${r.reasons.join('; ')}</b></span>`:''}</div>`;
    const sc=_dpScanCache[r.awb]; let scanHtml;
    if(!sc||sc.loading) scanHtml='<div class="text-slate-400 text-xs py-3">Loading scan log…</div>';
    else if(sc.error) scanHtml=`<div class="text-rose-400 text-xs py-3">Couldn’t load scans: ${sc.error}</div>`;
    else if(!sc.scans||!sc.scans.length) scanHtml='<div class="text-slate-400 text-xs py-3">No scan log available for this shipment.</div>';
    else scanHtml=`<div class="space-y-1 max-h-64 overflow-auto pr-1">${sc.scans.map(s=>`<div class="flex gap-2 text-xs"><span class="w-28 shrink-0 text-slate-400 tabular-nums">${dpFmtTs(s.at)}</span><span class="text-slate-700">${s.desc}${s.code?` <span class="text-slate-400">(${s.code})</span>`:''}${s.location?` <span class="text-slate-400">· ${s.location}</span>`:''}</span></div>`).join('')}</div>${sc.live?'<div class="text-[10px] text-emerald-500 mt-1">● fetched live from courier</div>':''}`;
    return `<tr class="dp-detail"><td colspan="11" class="px-6 py-4 bg-slate-50 border-b border-slate-200">
        <div class="grid md:grid-cols-2 gap-6">
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Date log</div>${timeline}${meta}</div>
          <div><div class="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">Scan log</div>${scanHtml}</div>
        </div></td></tr>`;
}
// Fetch the full scan log for one AWB (cached; served from DB if stored, else 1 live courier call).
async function dpLoadScans(awb){ _dpScanCache[awb]={loading:true}; try{
        const r=await fetch(`/api/delivery-performance/shipment/${encodeURIComponent(awb)}`,{headers:getAuthHeaders()});
        const d=await r.json(); if(!d.success) throw new Error(d.error||'failed');
        _dpScanCache[awb]={loading:false,scans:d.scans||[],live:!!d.live};
    }catch(e){ _dpScanCache[awb]={loading:false,error:e.message}; }
    if(_dpOpenAwb===awb) dpTableRender();
}

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

document.getElementById('btn-download-noattempt-report')?.addEventListener('click', async () => {
    const from = document.getElementById('noattempt-start-date').value;
    const to = document.getElementById('noattempt-end-date').value;
    if (!from || !to) { showNotification('Please select both start and end dates', true); return; }
    showNotification('Generating “RTO without attempt” report…');
    try {
        const blob = await fetchApiData(`/reports/rto-no-attempt?from=${from}&to=${to}`, 'Failed to generate report');
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rto-without-attempt_${from}_to_${to}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        showNotification('Report downloaded.');
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
    
    dashboardKpiElements = { 
    all: document.getElementById('kpi-dashboard-all'),
    newOrders: document.getElementById('kpi-dashboard-new'), 
    shipped: document.getElementById('kpi-dashboard-shipped'), 
    delivered: document.getElementById('kpi-dashboard-delivered'),
    cancelled: document.getElementById('kpi-dashboard-cancelled') 
    };
    insightsKpiElements = { 
        revenue: { el: document.getElementById('kpi-insights-revenue') }, 
        avgValue: { el: document.getElementById('kpi-insights-avg-value') }, 
        allOrders: { el: document.getElementById('kpi-insights-all-orders') }, 
        new: { el: document.getElementById('kpi-insights-new') }, 
        shipped: { el: document.getElementById('kpi-insights-shipped') }, 
        
        // --- MAKE SURE THIS LINE IS HERE ---
        delivered: { el: document.getElementById('kpi-insights-delivered') }, 
        // -----------------------------------

        rto: { el: document.getElementById('kpi-insights-rto') }, 
        cancelled: { el: document.getElementById('kpi-insights-cancelled') }
    };
    
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
    // --- NEW: Customer Segment Filters ---
    customerDatePresetFilter = document.getElementById('customer-date-preset-filter');
    customerCustomDateContainer = document.getElementById('customer-custom-date-container');
    customerStartDateFilterEl = document.getElementById('customer-start-date-filter');
    customerEndDateFilterEl = document.getElementById('customer-end-date-filter');

    // --- NEW: Ad Analysis Filters ---
    adAnalysisDatePresetFilter = document.getElementById('ad-analysis-date-preset-filter');
    adAnalysisCustomDateContainer = document.getElementById('ad-analysis-custom-date-container');
    adAnalysisStartDateFilterEl = document.getElementById('ad-analysis-start-date-filter');
    adAnalysisEndDateFilterEl = document.getElementById('ad-analysis-end-date-filter');

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
    }
});

// ── Fulfillment Ops ───────────────────────────────────────────────────────────
const FOPS_OPS_STATUSES = ['CONFIRMED','LABEL_PRINTED','LABEL_PURCHASED','FULFILLMENT_REQUESTED','READY_FOR_PICKUP'];
const FOPS_ALL_STATUSES = ['CONFIRMED','READY_FOR_PICKUP','MANIFESTED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','ATTEMPTED_DELIVERY','DELIVERED','RTO','REALLOCATION','LABEL_PRINTED','LABEL_PURCHASED','FULFILLMENT_REQUESTED','UNFULFILLED','CANCELLED','SHOPIFY_CANCELLED'];
// Runtime list = known statuses ∪ whatever statuses actually appear in the loaded data (kept in sync by fopsBuildChips).
let fopsAllStatuses = FOPS_ALL_STATUSES.slice();
const FOPS_DS_LABEL = {
  CONFIRMED:'Confirmed', READY_FOR_PICKUP:'Ready for pickup',
  IN_TRANSIT:'In transit', OUT_FOR_DELIVERY:'Out for delivery',
  ATTEMPTED_DELIVERY:'Attempted', DELIVERED:'Delivered',
  LABEL_PRINTED:'Label printed', LABEL_PURCHASED:'Label purchased',
  FULFILLMENT_REQUESTED:'Requested',
  SHIPPED:'Shipped', MANIFESTED:'Manifested',
  RTO:'RTO', CANCELLED:'Cancelled',
  REALLOCATION:'Reallocation Reqd',
  SHOPIFY_CANCELLED:'Shopify Cancelled',
  // Raw Shopify fulfillment statuses that can fall through fopsGetDS
  ON_THE_WAY:'On the way', NOT_DELIVERED:'Not delivered',
  PICKED_UP:'Picked up', FAILURE:'Failed', FULFILLED:'Fulfilled',
  SUBMITTED:'Submitted', MARKED_AS_FULFILLED:'Marked fulfilled',
  UNFULFILLED:'Unfulfilled'
};
const FOPS_DS_BADGE = {
  CONFIRMED:'bg-blue-100 text-blue-700',
  READY_FOR_PICKUP:'bg-purple-100 text-purple-700',
  IN_TRANSIT:'bg-amber-100 text-amber-800',
  SHIPPED:'bg-amber-100 text-amber-800',
  MANIFESTED:'bg-amber-100 text-amber-800',
  ON_THE_WAY:'bg-amber-100 text-amber-800',
  PICKED_UP:'bg-amber-100 text-amber-800',
  OUT_FOR_DELIVERY:'bg-emerald-100 text-emerald-700',
  ATTEMPTED_DELIVERY:'bg-rose-100 text-rose-700',
  NOT_DELIVERED:'bg-rose-100 text-rose-700',
  FAILURE:'bg-red-100 text-red-700',
  DELIVERED:'bg-slate-100 text-slate-600',
  FULFILLED:'bg-slate-100 text-slate-600',
  RTO:'bg-red-100 text-red-700',
  REALLOCATION:'bg-orange-100 text-orange-700',
  CANCELLED:'bg-slate-200 text-slate-500',
  SHOPIFY_CANCELLED:'bg-red-100 text-red-600',
  UNFULFILLED:'bg-slate-100 text-slate-400',
};
const FOPS_PER_PAGE = 50;

let fopsOrders  = [];
let fopsMode    = 'ops';
let fopsSortKey = 'date';
let fopsSortDir = -1;
let fopsPage    = 1;
let fopsActiveDS = new Set(FOPS_OPS_STATUSES);
let fopsInited  = false;

function fopsMTD() {
  const n = new Date();
  const y = n.getFullYear(), mo = n.getMonth(), d = n.getDate();
  const pad = x => String(x).padStart(2, '0');
  const fmtLocal = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  const startDate = new Date(y, mo, 1);
  const endDate   = new Date(y, mo, d - 2); // local date arithmetic — no UTC offset issue
  return {
    start: fmtLocal(startDate),
    end:   fmtLocal(endDate < startDate ? startDate : endDate) // clamp to start of month
  };
}

function fopsDateRange() {
  const preset = document.getElementById('fops-date-preset')?.value || 'mtd';
  const today  = new Date();
  const y = today.getFullYear(), mo = today.getMonth(), d = today.getDate();
  const pad = x => String(x).padStart(2, '0');
  const fmtL = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  const ago  = n => new Date(y, mo, d - n);
  if (preset === 'today')       return { start: fmtL(today), end: fmtL(today) };
  if (preset === 'yesterday')   return { start: fmtL(ago(1)), end: fmtL(ago(1)) };
  if (preset === 'last7')       return { start: fmtL(ago(6)), end: fmtL(today) };
  if (preset === 'last15')      return { start: fmtL(ago(14)), end: fmtL(today) };
  if (preset === 'last30')      return { start: fmtL(ago(29)), end: fmtL(today) };
  if (preset === 'mtd')         return fopsMTD();
  if (preset === 'this-month')  return { start: fmtL(new Date(y, mo, 1)),   end: fmtL(new Date(y, mo+1, 0)) };
  if (preset === 'last-month')  return { start: fmtL(new Date(y, mo-1, 1)), end: fmtL(new Date(y, mo, 0)) };
  // custom — read from inputs
  return { start: document.getElementById('fops-start')?.value || fmt(ago(29)), end: document.getElementById('fops-end')?.value || fmt(today) };
}

function fopsOnPresetChange() {
  const isCustom = document.getElementById('fops-date-preset')?.value === 'custom';
  document.getElementById('fops-custom-dates')?.classList.toggle('hidden', !isCustom);
  if (!isCustom) fopsFetch();
}

// Prettify a raw status key (e.g. "ON_THE_WAY" → "On the way") when no FOPS_DS_LABEL exists.
function fopsPretty(s) {
  return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// (Re)build the delivery-status filter chips from the union of the known statuses and
// whatever statuses actually appear in the loaded orders — so NO order is ever unfilterable.
function fopsBuildChips() {
  const chips = document.getElementById('fops-ds-chips');
  if (!chips) return;
  const present = [...new Set((fopsOrders || []).map(fopsGetDS).filter(Boolean))];
  fopsAllStatuses = [...new Set([...FOPS_ALL_STATUSES, ...present])];

  chips.innerHTML = '';
  const btnAll = document.createElement('button');
  btnAll.id = 'fops-chip-all';
  btnAll.className = 'fops-chip';
  btnAll.textContent = 'Select All';
  btnAll.onclick = () => {
    fopsAllStatuses.forEach(s => fopsActiveDS.add(s));
    document.querySelectorAll('#fops-ds-chips .fops-chip[data-s]').forEach(b => b.classList.add('active'));
    fopsPage = 1; fopsRenderTable();
  };
  chips.appendChild(btnAll);

  const btnNone = document.createElement('button');
  btnNone.id = 'fops-chip-none';
  btnNone.className = 'fops-chip';
  btnNone.textContent = 'Unselect All';
  btnNone.onclick = () => {
    fopsActiveDS.clear();
    document.querySelectorAll('#fops-ds-chips .fops-chip[data-s]').forEach(b => b.classList.remove('active'));
    fopsPage = 1; fopsRenderTable();
  };
  chips.appendChild(btnNone);

  fopsAllStatuses.forEach(s => {
    const b = document.createElement('button');
    b.className = 'fops-chip' + (fopsActiveDS.has(s) ? ' active' : '');
    b.dataset.s = s;
    b.textContent = FOPS_DS_LABEL[s] || fopsPretty(s);
    b.onclick = () => {
      if (fopsActiveDS.has(s)) fopsActiveDS.delete(s); else fopsActiveDS.add(s);
      b.classList.toggle('active', fopsActiveDS.has(s));
      fopsPage = 1; fopsRenderTable();
    };
    chips.appendChild(b);
  });
}

function fopsInit() {
  if (fopsInited) return;
  fopsInited = true;
  // build status chips for research mode (dynamic — covers every status in the data)
  fopsBuildChips();
  // auto-load immediately
  fopsFetch();
  // auto-refresh every 10 minutes
  if (window._fopsRefreshTimer) clearInterval(window._fopsRefreshTimer);
  window._fopsRefreshTimer = setInterval(() => {
    if (document.getElementById('fulfillment-ops-view') &&
        !document.getElementById('fulfillment-ops-view').classList.contains('hidden')) {
      fopsFetch();
    }
  }, 10 * 60 * 1000);
}

function fopsSetMode(m) {
  fopsMode = m;
  document.getElementById('fops-mode-ops').classList.toggle('active', m === 'ops');
  document.getElementById('fops-mode-research').classList.toggle('active', m === 'research');
  document.getElementById('fops-ops-bar').classList.toggle('hidden', m !== 'ops');
  document.getElementById('fops-research-panel').classList.toggle('hidden', m !== 'research');
  if (m === 'ops') {
    fopsActiveDS = new Set(FOPS_OPS_STATUSES);
    document.querySelectorAll('#fops-ds-chips .fops-chip').forEach(b => {
      b.classList.toggle('active', FOPS_OPS_STATUSES.includes(b.dataset.s));
    });
  }
  fopsPage = 1; fopsRenderTable();
}

async function fopsFetch() {
  const btn = document.getElementById('fops-fetch-btn');
  const tbody = document.getElementById('fops-tbody');
  btn.disabled = true;
  btn.innerHTML = `<span class="inline-flex items-center gap-2"><svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Fetching…</span>`;
  fopsOrders = [];
  if (tbody) tbody.innerHTML = `<tr><td colspan="9"><div class="flex flex-col items-center justify-center py-16 gap-4"><div style="position:relative;width:56px;height:56px;"><img src="/static/assets/ecom-logo.png" style="width:56px;height:56px;border-radius:14px;object-fit:contain;box-shadow:0 4px 16px rgba(79,70,229,0.18);animation:loader-logo-pulse 1.6s ease-in-out infinite;"><div class="loader-ring"></div></div><div class="text-xs text-slate-400 font-medium">Loading orders…</div></div></td></tr>`;
  const { start, end } = fopsMode === 'ops' ? fopsMTD() : fopsDateRange();
  fopsLog(`Fetching ${start} → ${end}…`);
  try {
    const res = await fetch('/api/fulfillment-ops/orders', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, mode: fopsMode })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || 'Unknown error');
    fopsOrders = d.orders || [];
    fopsBuildChips(); // refresh chips so any new status in the data becomes filterable
    const filtered = fopsGetFiltered();
    fopsLog(`Done — ${fopsOrders.length} total orders · ${filtered.length} match filters`);
    document.getElementById('fops-ts').textContent = `Updated ${new Date().toLocaleTimeString('en-IN',{hour12:false})} · ${fopsOrders.length} orders`;
    fopsPage = 1; fopsRenderTable();
  } catch (e) {
    fopsLog('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Fetch MTD';
  }
}

function fopsGetDS(o) {
  // RS status is checked first — RTO orders are marked as cancelled in Shopify but must show as RTO
  if (o.rapidshypStatus) {
    const s = o.rapidshypStatus.toLowerCase();
    // Courier couldn't service it → needs reallocation to another courier (action required)
    if (s.includes('realloc')) return 'REALLOCATION';
    // Refused / cancelled-at-delivery → shipment returns to origin = RTO
    if (s.includes('rto') || s.includes('refused') || s.includes('return')) return 'RTO';
    if (s.includes('delivered') && !s.includes('out') && !s.includes('undeliver')) return 'DELIVERED';
    if (s.includes('out for delivery'))                  return 'OUT_FOR_DELIVERY';
    if (s.includes('pickup completed') || s.includes('picked up') || s.includes('in transit') || s.includes('transit') || s.includes('shipped')) return 'IN_TRANSIT';
    if (s.includes('attempt') || s.includes('ndr') || s.includes('undeliver') || s.includes('delayed') || s.includes('not attempted')) return 'ATTEMPTED_DELIVERY';
    if (s.includes('cancel')) return 'RTO';
  }
  // Only treat as Shopify Cancelled if RS has no status (no RS data = genuinely cancelled, not RTO)
  if (o.cancelledAt) return 'SHOPIFY_CANCELLED';
  const f = o.fulfillments || [];
  // Always return a concrete bucket (never null) so every order is filterable.
  return (f.length && (f[0].displayStatus || '').toUpperCase()) || 'UNFULFILLED';
}
function fopsGetAWB(o) {
  const f = o.fulfillments || [];
  if (!f.length) return '';
  const ti = f[0].trackingInfo || [];
  return ti.length ? (ti[0].number || '') : '';
}
function fopsGetCarrier(o) {
  const f = o.fulfillments || [];
  if (!f.length) return '';
  const ti = f[0].trackingInfo || [];
  if (!ti.length) return '';
  const c = (ti[0].company || '').toLowerCase();
  if (c.includes('delhivery')) return 'Delhivery';
  if (c.includes('ekart')) return 'Ekart';
  if (c.includes('amazon')) return 'Amazon';
  return ti[0].company || '';
}
function fopsIsPrepaid(o) {
  return (o.tags||[]).some(t=>{ const u=t.toUpperCase(); return u.includes('PREPAID')||u==='UPI'||u.includes('CARD'); });
}
function fopsIsCOD(o) { return (o.tags||[]).some(t=>t.toUpperCase()==='COD'); }

function fopsGetFiltered() {
  const payF     = document.getElementById('fops-f-pay')?.value || '';
  const carrierF = document.getElementById('fops-f-carrier')?.value || '';
  const q        = (document.getElementById('fops-search')?.value || '').toLowerCase();
  return fopsOrders.filter(o => {
    const ds = fopsGetDS(o);
    if (!fopsActiveDS.has(ds)) return false;
    if (payF === 'prepaid' && !fopsIsPrepaid(o)) return false;
    if (payF === 'cod' && !fopsIsCOD(o)) return false;
    if (carrierF && !fopsGetCarrier(o).includes(carrierF)) return false;
    if (q) {
      const awb = fopsGetAWB(o);
      return (o.name||'').toLowerCase().includes(q) ||
             (o.customer?.displayName||'').toLowerCase().includes(q) ||
             awb.toLowerCase().includes(q);
    }
    return true;
  });
}

function fopsGetSorted(rows) {
  const sv = document.getElementById('fops-f-sort')?.value || 'date-desc';
  let k = fopsSortKey, d = fopsSortDir;
  if (fopsMode === 'research') {
    if (sv==='date-desc'){k='date';d=-1;} else if (sv==='date-asc'){k='date';d=1;}
    else if (sv==='amount-desc'){k='amount';d=-1;} else {k='amount';d=1;}
  }
  return [...rows].sort((a,b)=>{
    if (k==='name') return d*(a.name||'').localeCompare(b.name||'');
    if (k==='amount') return d*(parseFloat(a.totalPriceSet.shopMoney.amount)-parseFloat(b.totalPriceSet.shopMoney.amount));
    return d*(new Date(a.processedAt)-new Date(b.processedAt));
  });
}

function fopsToggleSort(k) {
  if (fopsMode === 'research') return;
  if (fopsSortKey === k) fopsSortDir *= -1; else { fopsSortKey = k; fopsSortDir = -1; }
  ['name','date','amount'].forEach(sk => {
    const el = document.getElementById('fops-sort-'+sk);
    if (!el) return;
    el.textContent = sk === fopsSortKey ? (fopsSortDir === -1 ? '↓' : '↑') : '↕';
    el.style.opacity = sk === fopsSortKey ? '1' : '0.4';
  });
  fopsPage = 1; fopsRenderTable();
}

function fopsChangePage(d) {
  const rows = fopsGetSorted(fopsGetFiltered());
  const tp = Math.ceil(rows.length / FOPS_PER_PAGE) || 1;
  fopsPage = Math.max(1, Math.min(tp, fopsPage + d));
  fopsRenderTable();
}

function fopsRenderMetrics(rows) {
  const count = s => rows.filter(o => fopsGetDS(o) === s).length;
  const gmv = rows.reduce((s,o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
  const n = rows.length || 1;
  const confirmed = count('CONFIRMED') + count('READY_FOR_PICKUP');
  const transit   = count('IN_TRANSIT');
  const ofd       = count('OUT_FOR_DELIVERY');
  const attempted = count('ATTEMPTED_DELIVERY');
  document.getElementById('fops-m-count').textContent     = rows.length.toLocaleString('en-IN');
  document.getElementById('fops-m-gmv').textContent       = '₹' + Math.round(gmv).toLocaleString('en-IN');
  document.getElementById('fops-m-confirmed').textContent = confirmed;
  document.getElementById('fops-m-confirmed-sub').textContent = Math.round(confirmed/n*100)+'% — awaiting pickup';
  document.getElementById('fops-m-transit').textContent   = transit;
  document.getElementById('fops-m-transit-sub').textContent = Math.round(transit/n*100)+'% of active';
  document.getElementById('fops-m-ofd').textContent       = ofd;
  document.getElementById('fops-m-ofd-sub').textContent   = Math.round(ofd/n*100)+'% of active';
  document.getElementById('fops-m-attempted').textContent = attempted;
  // status summary pills
  const statusCounts = {};
  rows.forEach(o => { const ds=fopsGetDS(o)||'UNKNOWN'; statusCounts[ds]=(statusCounts[ds]||0)+1; });
  const pills = document.getElementById('fops-status-pills');
  if (pills) pills.innerHTML = Object.entries(statusCounts).map(([s,c])=>
    `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold rounded-full border border-slate-200 bg-white text-slate-600">
      <span class="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold ${FOPS_DS_BADGE[s]||'bg-slate-100 text-slate-500'}">${FOPS_DS_LABEL[s]||s}</span>
      ${c}
    </span>`
  ).join('');
}

function fopsRenderTable() {
  const rows = fopsGetSorted(fopsGetFiltered());
  fopsRenderMetrics(rows);
  const tp    = Math.ceil(rows.length / FOPS_PER_PAGE) || 1;
  const start = (fopsPage-1) * FOPS_PER_PAGE;
  const page  = rows.slice(start, start + FOPS_PER_PAGE);
  const tbody = document.getElementById('fops-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center py-12 text-slate-400 text-sm">${fopsOrders.length?'No orders match current filters':'Click Fetch MTD to load orders'}</td></tr>`;
    document.getElementById('fops-pg-label').textContent = '';
    document.getElementById('fops-foot-label').textContent = '';
    document.getElementById('fops-pg-prev').disabled = true;
    document.getElementById('fops-pg-next').disabled = true;
    return;
  }
  tbody.innerHTML = page.map(o => {
    const dt  = new Date(o.processedAt);
    const ds  = fopsGetDS(o) || '';
    const awb = fopsGetAWB(o);
    const carrier = fopsGetCarrier(o);
    const amt = parseFloat(o.totalPriceSet.shopMoney.amount);
    const dateStr = dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' ' +
                    dt.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});
    const phone = o.customer?.phone || '';
    const payBadge = fopsIsPrepaid(o)
      ? '<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700">Prepaid</span>'
      : fopsIsCOD(o)
      ? '<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">COD</span>'
      : '<span class="text-slate-300 text-xs">—</span>';
    const enriching = fopsGetAWB(o) && !o.rapidshypStatus && !o.cancelledAt;
    const dsBadge = enriching
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-400"><span class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse flex-shrink-0"></span>${FOPS_DS_LABEL[ds]||ds||'—'}</span>`
      : `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${FOPS_DS_BADGE[ds]||'bg-slate-100 text-slate-500'}">${FOPS_DS_LABEL[ds]||ds||'—'}</span>`;
    const shopifyBadge = o.cancelledAt
      ? '<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600">Cancelled</span>'
      : '<span class="text-slate-300 text-[10px]">—</span>';
    return `<tr>
      <td class="font-semibold text-slate-700">${o.name}</td>
      <td class="text-slate-400 text-[11px]">${dateStr}</td>
      <td title="${o.customer?.displayName||''}${phone?' · '+phone:''}" class="text-slate-600">
        ${o.customer?.displayName||'<span class="text-slate-300">Guest</span>'}
        ${phone?`<br><span class="text-[10px] text-slate-400">${phone}</span>`:''}
      </td>
      <td class="font-semibold text-slate-700">₹${Math.round(amt).toLocaleString('en-IN')}</td>
      <td>${payBadge}</td>
      <td>${shopifyBadge}</td>
      <td>${dsBadge}</td>
      <td title="${awb}">${awb?`<button data-awb="${awb}" onclick="fopsTrack('${awb}','${carrier}','${(o.id||'').split('/').pop()}')" class="font-mono text-[11px] text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-1.5 py-0.5 rounded transition-colors -mx-0.5 cursor-pointer" title="Click to track live">${awb}</button>`:`<button data-fetchawb="${(o.id||'').split('/').pop()}" onclick="fopsFetchAwb('${(o.id||'').split('/').pop()}', this)" class="text-[10px] font-semibold text-indigo-500 hover:text-white hover:bg-indigo-500 border border-indigo-200 px-1.5 py-0.5 rounded transition-colors" title="Fetch AWB from DocPharma / RapidShyp and sync to Shopify">Fetch AWB</button>`}</td>
      <td class="text-[11px] text-slate-400">${carrier||'—'}</td>
    </tr>`;
  }).join('');
  document.getElementById('fops-pg-label').textContent = tp > 1 ? `${fopsPage} / ${tp}` : '';
  document.getElementById('fops-foot-label').textContent = `Showing ${start+1}–${Math.min(start+FOPS_PER_PAGE, rows.length)} of ${rows.length} orders`;
  document.getElementById('fops-pg-prev').disabled = fopsPage === 1;
  document.getElementById('fops-pg-next').disabled = fopsPage === tp;
  fopsEnrichVisiblePage();
}

function fopsLog(msg) { const el=document.getElementById('fops-log'); if(el) el.textContent=msg; }

function fopsUpdateRowBadge(awb, ds) {
  const label = FOPS_DS_LABEL[ds] || ds || '—';
  const cls   = FOPS_DS_BADGE[ds]  || 'bg-slate-100 text-slate-500';
  const btn = document.querySelector(`#fops-tbody button[data-awb="${awb}"]`);
  if (btn) {
    const tds = btn.closest('tr').querySelectorAll('td');
    if (tds[5]) tds[5].innerHTML = `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}">${label}</span>`;
  }
}

async function fopsEnrichVisiblePage() {
  const start = (fopsPage - 1) * FOPS_PER_PAGE;
  const visible = fopsGetSorted(fopsGetFiltered()).slice(start, start + FOPS_PER_PAGE);
  const toEnrich = visible.filter(o => fopsGetAWB(o) && !o.rapidshypStatus);
  if (!toEnrich.length) return;
  await Promise.all(toEnrich.map(async o => {
    const awb = fopsGetAWB(o);
    try {
      const res = await fetch(`/api/fulfillment-ops/status/${encodeURIComponent(awb)}`, {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const d = await res.json();
      if (d.rsStatus) {
        o.rapidshypStatus = d.rsStatus;
        fopsUpdateRowBadge(awb, fopsGetDS(o));
      }
    } catch (_) {}
  }));
  fopsRenderMetrics(fopsGetSorted(fopsGetFiltered()));
}

// Fetch AWB for an order with none in Shopify (DocPharma → RapidShyp), save it, and
// create a Shopify fulfillment with the tracking number.
async function fopsFetchAwb(numericId, btn) {
  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Fetching…</span>'; }
  try {
    const res = await fetch('/api/fulfillment-ops/fetch-awb', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numericId })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || 'Failed');

    if (d.found === false) {
      showNotification('No AWB found in DocPharma or RapidShyp — left as is.', true);
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
      return;
    }
    if (d.alreadyHadAwb) { showNotification('Order already has an AWB in Shopify.'); }

    // Patch the in-memory order so the row shows the new AWB + carrier
    const ord = fopsOrders.find(o => (o.id || '').split('/').pop() === String(numericId));
    if (ord) {
      ord.fulfillments = ord.fulfillments && ord.fulfillments.length ? ord.fulfillments : [{ trackingInfo: [{}] }];
      ord.fulfillments[0].trackingInfo = [{ number: d.awb, company: d.courier || d.source }];
      if (d.status) ord.rapidshypStatus = d.status;
    }
    const shop = d.shopify && d.shopify.ok ? ' · Shopify fulfillment created' : (d.shopify && d.shopify.error ? ` · Shopify: ${d.shopify.error}` : '');
    showNotification(`AWB ${d.awb} (${d.source})${shop}`);
    fopsRenderTable();
  } catch (e) {
    showNotification('Fetch AWB failed: ' + (e.message || e), true);
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

async function fopsTrack(awb, carrier, numericId) {
  const modal = document.getElementById('fops-track-modal');
  const body  = document.getElementById('fops-track-body');
  const statusBadge = document.getElementById('fops-track-status-badge');
  const sourceBadge = document.getElementById('fops-track-source-badge');
  document.getElementById('fops-track-awb').textContent = awb;
  document.getElementById('fops-track-carrier').textContent = carrier || '';
  statusBadge.className = 'hidden text-[11px] font-bold px-3 py-1 rounded-full';
  sourceBadge.classList.add('hidden');
  body.innerHTML = `
    <div class="flex flex-col items-center justify-center py-14 gap-4">
      <div style="position:relative;width:56px;height:56px;">
        <img src="/static/assets/ecom-logo.png" style="width:56px;height:56px;border-radius:14px;object-fit:contain;box-shadow:0 4px 16px rgba(79,70,229,0.18);animation:loader-logo-pulse 1.6s ease-in-out infinite;">
        <div class="loader-ring"></div>
      </div>
      <div class="text-xs text-slate-400 font-medium">Fetching live status…</div>
    </div>`;
  modal.classList.remove('hidden');
  try {
    const url = numericId
      ? `/api/fulfillment-ops/track-order/${numericId}`
      : `/api/fulfillment-ops/track/${encodeURIComponent(awb)}`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + authToken } });
    const d = await res.json();

    // If Shopify returned a different (newer) AWB, show it in the modal header
    const effectiveAWB = d.latestAWB || awb;
    if (effectiveAWB !== awb) {
      document.getElementById('fops-track-awb').textContent = effectiveAWB + ' (updated)';
    }

    // Live-update the matching order row's badge + AWB chip without re-rendering the table
    if (d.rsStatus) {
      const ord = fopsOrders.find(o => fopsGetAWB(o) === awb || fopsGetAWB(o) === effectiveAWB);
      if (ord) {
        ord.rapidshypStatus = d.rsStatus;
        // If AWB changed, patch it in the in-memory order so future logic uses the new one
        if (effectiveAWB !== awb && ord.fulfillments?.[0]?.trackingInfo?.[0]) {
          ord.fulfillments[0].trackingInfo[0].number = effectiveAWB;
          // Update AWB chip text + data-awb in the DOM
          const btn = document.querySelector(`#fops-tbody button[data-awb="${awb}"]`);
          if (btn) { btn.textContent = effectiveAWB; btn.dataset.awb = effectiveAWB; btn.setAttribute('onclick', `fopsTrack('${effectiveAWB}','${carrier}','${numericId}')`); }
        }
        fopsUpdateRowBadge(effectiveAWB, fopsGetDS(ord));
        fopsRenderMetrics(fopsGetSorted(fopsGetFiltered()));
      }
    }

    // Show Shopify-cancelled + RS cancel result banner
    if (d.shopifyCancelled) {
      const cancelBanner = d.rsCancelled
        ? `<div class="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-green-50 border border-green-200 text-xs text-green-700"><span class="font-bold">✓ RapidShyp cancel sent:</span> ${d.rsCancelMsg || 'Done'}</div>`
        : `<div class="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700"><span class="font-bold">⚠ Shopify Cancelled.</span> ${d.rsCancelMsg || 'RS cancel not attempted'}</div>`;
      body.innerHTML = cancelBanner + (d.events && d.events.length ? '' : `
        <div class="flex flex-col items-center justify-center py-8 gap-2 text-center">
          <div class="text-3xl">🚫</div>
          <div class="text-sm font-medium text-slate-600">Order cancelled in Shopify</div>
        </div>`);
      if (!d.events || !d.events.length) return;
    }

    if (!d.success || !d.events || !d.events.length) {
      body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-14 gap-2 text-center">
          <div class="text-3xl">📦</div>
          <div class="text-sm font-medium text-slate-600">No tracking events yet</div>
          <div class="text-xs text-slate-400">This shipment may not have been scanned by the courier yet.</div>
        </div>`;
      return;
    }

    // Status badge
    const latestStatus = d.easyecomStatus || d.events[0].status || '';
    if (latestStatus) {
      statusBadge.textContent = latestStatus;
      statusBadge.className = 'text-[11px] font-bold px-3 py-1 rounded-full bg-indigo-100 text-indigo-700';
    }

    const scanEvents = d.events || [];
    const noScans = scanEvents.length === 0;
    if (noScans) sourceBadge.classList.remove('hidden');

    // EasyEcom confirmation note (always shown when status is available)
    const eeNote = d.easyecomStatus ? `
      <div class="mb-4 flex items-center gap-2.5 px-3 py-2.5 rounded-xl ${noScans ? 'bg-amber-50 border border-amber-100' : 'bg-slate-50 border border-slate-100'}">
        <span class="text-base flex-shrink-0">${noScans ? '⚠️' : '✅'}</span>
        <div class="text-xs leading-relaxed ${noScans ? 'text-amber-700' : 'text-slate-600'}">
          <span class="font-semibold">EasyEcom:</span> ${d.easyecomStatus}${noScans ? ' — courier scan not yet received' : ''}
        </div>
      </div>` : '';

    // Banner when we pushed RapidShyp's status onto Shopify (status mismatch reconciled)
    const sp = d.statusPush || {};
    const pushBanner = sp.pushed ? `
      <div class="mb-4 flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-blue-50 border border-blue-100">
        <span class="text-base flex-shrink-0">🔄</span>
        <div class="text-xs leading-relaxed text-blue-700">
          <span class="font-semibold">Shopify status updated to match RapidShyp:</span>
          ${sp.from || '—'} → <span class="font-semibold">${(FOPS_DS_LABEL[sp.to] || sp.to)}</span>
        </div>
      </div>` : '';

    body.innerHTML = pushBanner + eeNote +
    (scanEvents.length ? `<div class="space-y-0">` + scanEvents.map((ev, i) => `
      <div class="flex gap-3.5 ${i < scanEvents.length - 1 ? 'pb-5' : 'pb-1'}">
        <div class="flex flex-col items-center pt-1 flex-shrink-0">
          <div class="w-3 h-3 rounded-full border-2 flex-shrink-0 ${i === 0 ? 'bg-indigo-500 border-indigo-500 shadow-sm shadow-indigo-200' : 'bg-white border-slate-300'}"></div>
          ${i < scanEvents.length - 1 ? '<div class="w-px flex-1 bg-gradient-to-b from-slate-200 to-transparent mt-1 min-h-[20px]"></div>' : ''}
        </div>
        <div class="flex-1 min-w-0 pb-1">
          <div class="text-sm font-semibold text-slate-800 leading-snug">${ev.status || '—'}</div>
          ${ev.location ? `<div class="flex items-center gap-1 mt-0.5"><svg class="w-3 h-3 text-slate-300 flex-shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2"><path d="M8 2C5.79 2 4 3.79 4 6c0 3.54 4 8 4 8s4-4.46 4-8c0-2.21-1.79-4-4-4z"/></svg><span class="text-xs text-slate-500 truncate">${ev.location}</span></div>` : ''}
          <div class="text-[11px] text-slate-400 mt-0.5">${ev.timestamp || ''}</div>
        </div>
      </div>`).join('') + `</div>`
    : noScans ? '' : `<div class="flex flex-col items-center justify-center py-10 gap-2 text-center"><div class="text-3xl">📦</div><div class="text-sm font-medium text-slate-600">No courier scan events yet</div></div>`);
  } catch (e) {
    body.innerHTML = `<div class="flex flex-col items-center justify-center py-12 gap-2"><div class="text-2xl">❌</div><div class="text-sm text-red-500">${e.message}</div></div>`;
  }
}

function fopsCloseTrack() {
  document.getElementById('fops-track-modal').classList.add('hidden');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') fopsCloseTrack(); });

function fopsExportCSV() {
  const rows = fopsGetSorted(fopsGetFiltered());
  if (!rows.length) return;
  const h = ['Order','Date','Customer','Phone','Email','Amount (INR)','Payment','Delivery Status','AWB','Carrier'];
  const lines = rows.map(o => [
    o.name, o.processedAt,
    o.customer?.displayName||'', o.customer?.phone||'', o.customer?.email||'',
    parseFloat(o.totalPriceSet.shopMoney.amount).toFixed(2),
    fopsIsPrepaid(o)?'Prepaid':fopsIsCOD(o)?'COD':o.displayFinancialStatus,
    fopsGetDS(o)||'', fopsGetAWB(o), fopsGetCarrier(o)
  ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
  const { start, end } = fopsMTD();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([[h.join(','),...lines].join('\n')], {type:'text/csv'}));
  a.download = `fulfillment-ops-${start}-${end}.csv`;
  a.click();
}
// ── End Fulfillment Ops ───────────────────────────────────────────────────────

// ════════════════════════ SERVICEABILITY CHECKER ════════════════════════════
let _srvInited = false;
function srvInit() {
  if (_srvInited) return;
  _srvInited = true;
  // Default pickup to the configured warehouse pincode; digits-only inputs.
  const pickup = document.getElementById('srv-pickup');
  if (pickup && !pickup.value) pickup.value = '122101';
  ['srv-pickup', 'srv-delivery'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 6); });
  });
  ['srv-weight', 'srv-value'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => { el.value = el.value.replace(/[^\d.]/g, ''); });
  });
}

async function srvCheck(e) {
  e.preventDefault();
  const pickup = document.getElementById('srv-pickup').value.trim();
  const delivery = document.getElementById('srv-delivery').value.trim();
  if (!/^\d{6}$/.test(pickup) || !/^\d{6}$/.test(delivery)) {
    showNotification('Enter valid 6-digit pickup and delivery pincodes.', true);
    return;
  }
  const btn = document.getElementById('srv-submit');
  const resultsEl = document.getElementById('srv-results');
  btn.disabled = true; btn.textContent = 'Checking…';
  resultsEl.innerHTML = `<div class="card p-6 text-center text-sm text-slate-400">Checking serviceability…</div>`;
  try {
    const data = await fetchApiData('/serviceability/check', 'Serviceability check failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pickup_pincode: pickup,
        delivery_pincode: delivery,
        weight: Number(document.getElementById('srv-weight').value) || 0.5,
        total_order_value: Number(document.getElementById('srv-value').value) || 0,
        cod: document.getElementById('srv-cod').checked,
        is_return: document.getElementById('srv-return').checked
      })
    });
    srvRenderResult(data);
  } catch (err) {
    resultsEl.innerHTML = `<div class="card p-6 text-sm text-rose-600">${err && err.message ? err.message : 'Request failed'}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Check serviceability';
  }
}

function srvExtractCouriers(resp) {
  const list = resp && resp.serviceable_courier_list;
  if (!Array.isArray(list)) return [];
  const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null));
  const str = v => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : null));
  return list.map(c => (c || {})).map(c => ({
    code: str(c.courier_code) || '',
    name: str(c.courier_name) || 'Courier',
    brand: str(c.parent_courier_name) || '',
    mode: str(c.freight_mode) || '',
    rate: num(c.total_freight),
    edd: str(c.edd),
    cutoff: str(c.cutoff_time),
    minWeight: num(c.min_weight),
    maxWeight: num(c.max_weight)
  }));
}

function srvEddTs(edd) {
  const m = String(edd || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return Infinity;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}
function srvFormatEdd(edd) {
  const m = String(edd || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return { date: edd || '—', days: null };
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((dt.getTime() - today.getTime()) / 86400000);
  return {
    date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    days: diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `${diff} days`
  };
}

function srvStatCard(label, value, hint) {
  return `<div class="card p-4">
    <div class="text-[10px] text-slate-400 uppercase tracking-wide font-bold">${label}</div>
    <div class="text-xl font-bold text-slate-800 mt-1">${value}</div>
    ${hint ? `<div class="text-[11px] text-slate-400 mt-0.5 truncate">${hint}</div>` : ''}
  </div>`;
}

function srvRenderResult(data) {
  const resultsEl = document.getElementById('srv-results');
  if (data && data.error) {
    resultsEl.innerHTML = `<div class="card p-6 text-sm text-rose-600">${data.error}</div>`;
    return;
  }
  const response = (data && data.response && typeof data.response === 'object') ? data.response : {};
  const request = (data && data.request && typeof data.request === 'object') ? data.request : {};
  const apiOk = response.status === true;
  const couriers = srvExtractCouriers(response);
  const serviceable = apiOk && couriers.length > 0;
  const remark = typeof response.remark === 'string' ? response.remark : '';

  const rates = couriers.map(c => c.rate).filter(r => typeof r === 'number');
  const cheapest = rates.length ? Math.min(...rates) : null;
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const fastest = [...couriers].filter(c => c.edd).sort((a, b) => srvEddTs(a.edd) - srvEddTs(b.edd))[0];
  const cheapestCourier = [...couriers].filter(c => c.rate !== null).sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))[0];
  const brands = Array.from(new Set(couriers.map(c => c.brand).filter(Boolean)));
  const sorted = [...couriers].sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity));

  const hero = `
    <div class="card p-6 border-l-4 ${serviceable ? 'border-l-emerald-500' : 'border-l-rose-500'}">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex items-start gap-4">
          <div class="h-11 w-11 rounded-full flex items-center justify-center text-lg font-bold ${serviceable ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">${serviceable ? '✓' : '✕'}</div>
          <div>
            <h2 class="text-lg font-bold text-slate-800">${serviceable ? 'Route is serviceable' : 'Route is not serviceable'}</h2>
            <p class="text-xs text-slate-500 mt-1">
              <span class="font-mono">${request.Pickup_pincode || ''}</span>
              <span class="mx-2 text-slate-300">→</span>
              <span class="font-mono">${request.Delivery_pincode || ''}</span>
              ${request.weight != null ? `<span class="ml-3">· ${request.weight} kg</span>` : ''}
              <span class="ml-3">· ${request.cod ? 'COD' : 'Prepaid'}</span>
              ${request.is_return ? `<span class="ml-3 text-amber-600 font-semibold">· Return</span>` : ''}
            </p>
            ${remark && remark.toLowerCase() !== 'success' ? `<p class="text-xs text-slate-500 mt-1">${remark}</p>` : ''}
          </div>
        </div>
        <span class="px-3 py-1 rounded-full text-[11px] font-bold ${serviceable ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${serviceable ? 'Serviceable' : 'Unserviceable'}</span>
      </div>
    </div>`;

  const stats = `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      ${srvStatCard('Couriers', String(couriers.length), `${brands.length} brand${brands.length !== 1 ? 's' : ''}`)}
      ${srvStatCard('Cheapest', cheapest !== null ? `₹${cheapest.toFixed(2)}` : '—', cheapestCourier ? cheapestCourier.name : '')}
      ${srvStatCard('Avg rate', avg !== null ? `₹${avg.toFixed(2)}` : '—', '')}
      ${srvStatCard('Fastest', fastest ? srvFormatEdd(fastest.edd).date : '—', fastest ? fastest.name : '')}
    </div>`;

  let table = '';
  if (couriers.length) {
    const rows = sorted.map(c => {
      const edd = srvFormatEdd(c.edd);
      const isCheap = cheapestCourier && cheapestCourier.code === c.code;
      const isFast = fastest && fastest.code === c.code;
      return `<tr class="border-t border-slate-100 hover:bg-slate-50">
        <td class="px-4 py-3">
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-md bg-slate-100 flex items-center justify-center text-[11px] font-bold text-slate-500">${(c.brand || c.name).slice(0, 2).toUpperCase()}</div>
            <div>
              <div class="text-sm font-semibold text-slate-700 flex items-center gap-1.5">${c.name}
                ${isCheap ? '<span class="px-1.5 py-0 text-[9px] font-bold rounded bg-emerald-100 text-emerald-700 uppercase">Cheapest</span>' : ''}
                ${isFast && !isCheap ? '<span class="px-1.5 py-0 text-[9px] font-bold rounded bg-sky-100 text-sky-700 uppercase">Fastest</span>' : ''}
              </div>
              <div class="text-[11px] text-slate-400">${c.brand || ''} · #${c.code}</div>
            </div>
          </div>
        </td>
        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${c.mode === 'Air' ? 'bg-sky-50 text-sky-600' : 'bg-amber-50 text-amber-700'}">${c.mode || '—'}</span></td>
        <td class="px-4 py-3 text-right font-mono font-semibold text-slate-700">${c.rate !== null ? `₹${c.rate.toFixed(2)}` : '—'}</td>
        <td class="px-4 py-3"><div class="text-sm text-slate-700">${edd.date}</div>${edd.days ? `<div class="text-[10px] text-slate-400">${edd.days}</div>` : ''}</td>
        <td class="px-4 py-3 font-mono text-xs text-slate-500">${c.cutoff || '—'}</td>
        <td class="px-4 py-3 text-[11px] text-slate-400">${c.minWeight !== null && c.maxWeight !== null ? `${c.minWeight}g – ${c.maxWeight}g` : '—'}</td>
      </tr>`;
    }).join('');
    table = `
      <div class="card overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100"><h3 class="text-sm font-bold text-slate-700">Available couriers <span class="text-slate-400 font-normal">· ${couriers.length}</span></h3></div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 font-bold">
              <tr>
                <th class="px-4 py-2.5">Courier</th><th class="px-4 py-2.5">Mode</th>
                <th class="px-4 py-2.5 text-right">Freight</th><th class="px-4 py-2.5">Est. delivery</th>
                <th class="px-4 py-2.5">Cutoff</th><th class="px-4 py-2.5">Weight range</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  const raw = `
    <div>
      <button onclick="const p=document.getElementById('srv-raw'); p.classList.toggle('hidden'); this.textContent = p.classList.contains('hidden') ? 'Show raw response' : 'Hide raw response';"
              class="text-xs text-slate-400 hover:text-slate-600">Show raw response</button>
      <pre id="srv-raw" class="hidden mt-2 text-[11px] bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-auto max-h-96 text-slate-600">${JSON.stringify(response || data, null, 2).replace(/</g, '&lt;')}</pre>
    </div>`;

  resultsEl.innerHTML = hero + stats + table + raw;
}
// ── End Serviceability ────────────────────────────────────────────────────────