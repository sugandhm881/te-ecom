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
        ordersListEl.innerHTML = `<tr><td colspan="10" class="p-8 text-center text-slate-400">No orders found.</td></tr>`;
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
            <td colspan="10" class="p-0">
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
const AMZ_SB        = 'https://urtwdqmiypjhnduspmwk.supabase.co';
const AMZ_DATA_FN   = AMZ_SB + '/functions/v1/amazon-review-data';
const AMZ_SINGLE_FN = AMZ_SB + '/functions/v1/amazon-review-single';
const AMZ_ANON      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVydHdkcW1peXBqaG5kdXNwbXdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4Nzk0MzcsImV4cCI6MjA4NjQ1NTQzN30.R3BmRpkn1C_uq5Wd3pyDUts5GA9xYdNLnuztTZ9Uszw';
const AMZ_HDR       = { 'apikey': AMZ_ANON, 'Authorization': 'Bearer ' + AMZ_ANON, 'Content-Type': 'application/json' };
const AMZ_DELAY_MS  = 1200;

let amzOrders = [], amzReqStatus = {}, amzSelected = new Set();
let amzCurrentPreset = '7d', amzDateFrom = null, amzDateTo = null;
let amzOpenOrderId = null, amzReviewLoaded = false;

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
function amzRevIsEligible(o){ const d=amzRevDaysSince(amzRevGetDD(o)); return d!==null&&d>=5&&d<=30&&amzReqStatus[o.amazon_order_id]?.solicitation_status!=='sent'; }

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
    const res=await fetch(AMZ_DATA_FN,{method:'POST',headers:AMZ_HDR,body:JSON.stringify({date_from:from,date_to:to})});
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
  // Eligible = in 5-30d window AND not yet sent (truly actionable)
  document.getElementById('amzrev-s-elig').textContent=m.filter(o=>o.ddays>=5&&o.ddays<=30&&!sentIds.has(o.amazon_order_id)).length||'0';
  document.getElementById('amzrev-s-sent').textContent=sentIds.size||'0';
  // Awaiting = too fresh (<5d), not yet in window
  document.getElementById('amzrev-s-fresh').textContent=m.filter(o=>o.ddays!==null&&o.ddays<5&&!sentIds.has(o.amazon_order_id)).length||'0';
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
  return`<div class="amzrev-detail-inner px-8 py-5">
    <div class="grid grid-cols-3 gap-3 mb-4">
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
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Solicitation status</p>
        <div class="mt-0.5">${stBadge}</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Attempted at</p>
        <p class="text-sm font-semibold text-slate-700">${req?.attempted_at?amzRevFmtDT(req.attempted_at):'—'}</p>
      </div>
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
  const detailTd=document.createElement('td'); detailTd.colSpan=9; detailTd.innerHTML=amzRevBuildDetailHTML(orderId);
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

function amzRevSetStatusFilter(value){
  // Update pill button active state
  document.querySelectorAll('#amazon-review-view .amzrev-sf').forEach(b=>{
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
  const activeBtn=document.querySelector('#amazon-review-view .amzrev-sf.active');
  const fw=activeBtn?activeBtn.dataset.filter:'';
  let f=amzOrders.map(o=>({...o,deliveryDate:amzRevGetDD(o),ddays:amzRevDaysSince(amzRevGetDD(o))}));
  if(srch)f=f.filter(o=>o.amazon_order_id.toLowerCase().includes(srch));
  if(fw){f=f.filter(o=>{
    const tag=amzRevWindowTag(o.ddays),st=amzReqStatus[o.amazon_order_id]?.solicitation_status;
    if(fw==='sent')return st==='sent'; if(fw==='failed')return st==='failed'; return tag.filter===fw;
  });}
  const tb=document.getElementById('amzrev-tbody'),em=document.getElementById('amzrev-empty');
  amzOpenOrderId=null;
  if(!f.length){tb.innerHTML=''; em.classList.remove('hidden'); return;}
  em.classList.add('hidden');
  tb.innerHTML=f.map(o=>{
    const d=o.ddays,tag=amzRevWindowTag(d),st=amzReqStatus[o.amazon_order_id]?.solicitation_status;
    const elig=amzRevIsEligible(o),isSel=amzSelected.has(o.amazon_order_id);
    const amt=o.order_total_amount?'₹'+Number(o.order_total_amount).toLocaleString('en-IN'):'—';
    let actionBtn;
    const btnBase='px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all';
    if(st==='sent')
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
      <td class="py-4 px-4" onclick="event.stopPropagation()"><input type="checkbox" class="w-4 h-4 text-indigo-600 rounded border-slate-300 cursor-pointer amzrev-row-cb" data-id="${o.amazon_order_id}" ${!elig?'disabled':''} ${isSel?'checked':''} onchange="amzRevToggleSelect('${o.amazon_order_id}',this.checked)"></td>
      <td class="py-4 px-4 font-mono text-xs text-slate-600">${o.amazon_order_id}</td>
      <td class="py-4 px-4 text-xs text-slate-500">${amzRevFmtDate(o.purchase_date)}</td>
      <td class="py-4 px-4 text-xs text-slate-500">${o.deliveryDate?amzRevFmtDate(o.deliveryDate):'—'}</td>
      <td class="py-4 px-4"><span class="${amzRevDaysCls(d)} text-xs">${d!==null?d+'d':'—'}</span></td>
      <td class="py-4 px-4 text-xs text-slate-700">${amt}</td>
      <td class="py-4 px-4"><span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${tag.badge}">${tag.label}</span></td>
      <td class="py-4 px-4">${stPill}</td>
      <td class="py-4 px-4 text-right pr-6">${actionBtn}</td>
    </tr>`;
  }).join('');
}

async function amzRevSendSingle(orderId){
  const btn=document.getElementById('amzrev-btn-'+orderId);
  const btnBase='px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all';
  if(btn){btn.disabled=true;btn.innerHTML='↻ Sending…';btn.className=btnBase+' bg-amber-50 text-amber-700 border-amber-200 cursor-wait';}
  showLoader();
  try{
    const r=await fetch(AMZ_SINGLE_FN,{method:'POST',headers:AMZ_HDR,body:JSON.stringify({order_id:orderId})});
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
    try{
      const r=await fetch(AMZ_SINGLE_FN,{method:'POST',headers:AMZ_HDR,body:JSON.stringify({order_id:orderId})});
      const d=await r.json();
      amzReqStatus[orderId]={solicitation_status:d.success?'sent':'failed',attempted_at:new Date().toISOString(),response_code:d.status,response_body:d.body};
      if(d.success)sent++;else failed++;
    }catch(e){ amzReqStatus[orderId]={solicitation_status:'failed',attempted_at:new Date().toISOString()}; failed++; }
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