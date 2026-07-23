// Session Records Management System — static client for GitHub Pages
// Talks to the Google Apps Script web app (see ../apps-script/Code.gs),
// which stores everything in a Google Sheet and syncs records to Notion.

const API_URL = (window.SRA_CONFIG && window.SRA_CONFIG.API_URL) || '';
const TOKEN_KEY = 'sra_token';

let currentUser = null;
let isLoading = false;

// ── API helper ───────────────────────────────────────────────────────────────
// No Content-Type header on purpose: a text/plain "simple request" avoids the
// CORS preflight that Apps Script web apps cannot answer.
async function api(action, payload = {}) {
    const body = JSON.stringify(Object.assign({
        action,
        token: localStorage.getItem(TOKEN_KEY) || null
    }, payload));

    const response = await fetch(API_URL, { method: 'POST', body });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function apiConfigured() {
    return /^https?:\/\//.test(API_URL);
}

// ── UI utilities ─────────────────────────────────────────────────────────────
function showAlert(message, type = 'success') {
    const alertContainer = document.getElementById('alertContainer');
    alertContainer.innerHTML = '';
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    alertContainer.appendChild(alertDiv);

    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertContainer.removeChild(alertDiv);
        }
    }, 5000);
}

function setLoadingState(buttonElement, loading) {
    if (loading) {
        buttonElement.disabled = true;
        buttonElement.setAttribute('data-original-text', buttonElement.textContent);
        buttonElement.textContent = 'Loading...';
        buttonElement.style.opacity = '0.7';
    } else {
        buttonElement.disabled = false;
        buttonElement.textContent = buttonElement.getAttribute('data-original-text') || 'Submit';
        buttonElement.style.opacity = '1';
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

// ── Authentication ───────────────────────────────────────────────────────────
async function register() {
    if (isLoading) return;

    const userID = document.getElementById('regUserID').value.trim();
    const password = document.getElementById('regPassword').value;
    const registerBtn = document.getElementById('registerBtn');

    // No length rules — any non-empty UserID and password are accepted.
    if (!userID || !password) {
        showAlert('Please fill in all fields', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(registerBtn, true);

    try {
        const result = await api('register', { userID, password });
        showAlert(result.message, result.success ? 'success' : 'error');

        if (result.success) {
            document.getElementById('regUserID').value = '';
            document.getElementById('regPassword').value = '';
            localStorage.setItem('lastUser', userID);
            setTimeout(() => {
                showLogin();
                document.getElementById('loginUserID').value = userID;
            }, 1500);
        }
    } catch (error) {
        console.error('Registration error:', error);
        showAlert('Registration failed. Please try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(registerBtn, false);
    }
}

async function login() {
    if (isLoading) return;

    const userID = document.getElementById('loginUserID').value.trim();
    const password = document.getElementById('loginPassword').value;
    const loginBtn = document.getElementById('loginBtn');

    if (!userID || !password) {
        showAlert('Please fill in all fields', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(loginBtn, true);

    try {
        const result = await api('login', { userID, password });

        if (result.success) {
            currentUser = userID;
            localStorage.setItem(TOKEN_KEY, result.token);
            localStorage.setItem('lastUser', userID);
            document.getElementById('loginPassword').value = '';

            showAlert('Login successful!', 'success');
            setTimeout(() => showAccessCode(), 1000);
        } else {
            showAlert(result.message, 'error');
        }
    } catch (error) {
        console.error('Login error:', error);
        showAlert('Login failed. Please check your connection and try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(loginBtn, false);
    }
}

async function checkAccessCode() {
    if (isLoading) return;

    const accessCode = document.getElementById('accessCode').value.trim();
    const submitBtn = document.getElementById('checkAccessBtn');

    if (!accessCode) {
        showAlert('Please enter access code', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(submitBtn, true);

    try {
        const result = await api('checkAccessCode', { accessCode });

        if (result.success) {
            showAlert('Access granted!', 'success');
            setTimeout(() => {
                showApp();
                refreshRecords();
            }, 1000);
        } else {
            showAlert(result.message, 'error');
        }
    } catch (error) {
        console.error('Access code error:', error);
        showAlert('Access code verification failed. Please try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(submitBtn, false);
    }
}

async function logout() {
    if (!confirm('Are you sure you want to logout?')) return;
    try {
        await api('logout');
    } catch (error) {
        console.error('Logout error:', error);
    }
    localStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    document.getElementById('loginPassword').value = '';
    document.getElementById('accessCode').value = '';
    showAlert('Logged out successfully', 'success');
    setTimeout(() => showLogin(), 500);
}

// Resume a still-valid session so a page refresh doesn't force a re-login
async function resumeSession() {
    if (!localStorage.getItem(TOKEN_KEY)) return false;
    try {
        const result = await api('session');
        if (result.authenticated) {
            currentUser = result.userID;
            showApp();
            refreshRecords();
            return true;
        }
    } catch (error) {
        console.error('Session check error:', error);
    }
    localStorage.removeItem(TOKEN_KEY);
    return false;
}

// ── Records ──────────────────────────────────────────────────────────────────
async function addRecord() {
    if (isLoading) return;

    const department = document.getElementById('department').value;
    const notesFile = document.getElementById('notesFile').files[0];
    const syllabusText = document.getElementById('syllabusText').value.trim();
    const addBtn = document.getElementById('addRecordBtn');

    if (!department) {
        showAlert('Please select a department', 'error');
        return;
    }
    if (notesFile) {
        if (notesFile.type !== 'application/pdf') {
            showAlert('Only PDF files are allowed', 'error');
            return;
        }
        if (notesFile.size > 20 * 1024 * 1024) {
            showAlert('File size must be less than 20MB', 'error');
            return;
        }
    }
    if (!notesFile && !syllabusText) {
        showAlert('Please provide either a notes file or syllabus text', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(addBtn, true);

    try {
        const payload = { department, syllabusText };
        if (notesFile) {
            showAlert('📤 Uploading file... This may take a moment.', 'success');
            payload.fileName = notesFile.name;
            payload.fileSize = notesFile.size;
            payload.fileData = await fileToBase64(notesFile);
        }

        const result = await api('addRecord', payload);
        showAlert(result.message, result.success ? 'success' : 'error');

        if (result.success) {
            document.getElementById('notesFile').value = '';
            document.getElementById('syllabusText').value = '';
            setTimeout(() => refreshRecords(), 500);
        }
    } catch (error) {
        console.error('Add record error:', error);
        showAlert('Failed to add record. Please check your connection and try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(addBtn, false);
    }
}

async function refreshRecords() {
    try {
        const result = await api('records');
        if (result.success) {
            updateRecordsTable(result.data);
        } else {
            showAlert('Failed to load records: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Refresh records error:', error);
        showAlert('Failed to load records. Please check your connection.', 'error');
    }
    refreshCounts();
}

// Session totals, one block per year (newest first), split by department
async function refreshCounts() {
    try {
        const result = await api('counts');
        if (result.success) updateCountsDisplay(result.data);
    } catch (error) {
        console.error('Refresh counts error:', error);
    }
}

function updateCountsDisplay(counts) {
    const container = document.getElementById('countsContainer');
    if (!container) return;
    container.innerHTML = '';
    if (!counts || counts.length === 0) return;

    const heading = document.createElement('h3');
    heading.textContent = 'Session Totals';
    container.appendChild(heading);

    const years = [...new Set(counts.map(c => c.year))].sort().reverse();

    years.forEach(year => {
        const rows = counts
            .filter(c => c.year === year)
            .sort((a, b) => a.department.localeCompare(b.department));

        const block = document.createElement('div');
        block.className = 'counts-year';

        const label = document.createElement('div');
        label.className = 'counts-year-label';
        label.textContent = year;

        const total = document.createElement('span');
        total.className = 'counts-total';
        total.textContent = `${rows.reduce((sum, c) => sum + c.count, 0)} sessions`;
        label.appendChild(total);
        block.appendChild(label);

        const items = document.createElement('div');
        items.className = 'counts-items';
        rows.forEach(c => {
            const tile = document.createElement('div');
            tile.className = 'counts-item';

            const dept = document.createElement('span');
            dept.className = 'counts-dept';
            dept.textContent = c.department;      // textContent, never innerHTML

            const num = document.createElement('span');
            num.className = 'counts-num';
            num.textContent = c.count;

            tile.appendChild(num);
            tile.appendChild(dept);
            items.appendChild(tile);
        });
        block.appendChild(items);
        container.appendChild(block);
    });
}

async function clearRecords() {
    if (!confirm('⚠️ ARE YOU SURE?\n\nThis will move ALL records to the archive.\nFiles will remain in Drive but won\'t be listed here.\nThis action CANNOT be undone from the app!')) {
        return;
    }
    const userConfirmation = prompt('Type "DELETE" to confirm:');
    if (userConfirmation !== 'DELETE') {
        showAlert('Action cancelled', 'error');
        return;
    }

    if (isLoading) return;

    const clearBtn = document.getElementById('clearRecordsBtn');
    isLoading = true;
    setLoadingState(clearBtn, true);

    try {
        const result = await api('clearRecords');
        showAlert(result.message, result.success ? 'success' : 'error');
        if (result.success) {
            setTimeout(() => refreshRecords(), 1000);
        }
    } catch (error) {
        console.error('Clear records error:', error);
        showAlert('Failed to clear records. Please try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(clearBtn, false);
    }
}

// Files live in Google Drive — direct links, no server round-trip needed
function downloadFile(fileId, fileName) {
    if (!fileId) {
        showAlert('No file to download', 'error');
        return;
    }
    const link = document.createElement('a');
    link.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
    link.download = fileName || 'file.pdf';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showAlert(`Downloading ${fileName || 'file'}...`, 'success');
}

function viewFile(fileId) {
    if (!fileId) {
        showAlert('No file to view', 'error');
        return;
    }
    window.open(`https://drive.google.com/file/d/${fileId}/view`, '_blank');
}

function updateRecordsTable(records) {
    const tbody = document.querySelector('#recordsTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!records || records.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="7" style="text-align: center; padding: 30px; color: #6c757d; font-style: italic;">📋 No records found. Add your first record above!</td>';
        tbody.appendChild(row);
        return;
    }

    records.forEach(record => {
        const row = document.createElement('tr');

        const idTd = document.createElement('td');
        idTd.textContent = record.id || '';
        row.appendChild(idTd);

        const dateTimeTd = document.createElement('td');
        if (record.dateTime) {
            const date = new Date(record.dateTime);
            dateTimeTd.textContent = date.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        }
        row.appendChild(dateTimeTd);

        const departmentTd = document.createElement('td');
        departmentTd.textContent = record.department || '';
        row.appendChild(departmentTd);

        const userIDTd = document.createElement('td');
        userIDTd.textContent = record.userID || '';
        row.appendChild(userIDTd);

        const fileTd = document.createElement('td');
        if (record.fileName) {
            const sizeKB = Math.round((record.fileSize || 0) / 1024);
            fileTd.textContent = `📄 ${record.fileName} (${sizeKB}KB)`;
            fileTd.style.color = '#007bff';
            fileTd.title = record.notionSynced
                ? 'Stored in Drive and synced to Notion'
                : 'Stored in Drive';
        }
        row.appendChild(fileTd);

        const syllabusTd = document.createElement('td');
        const text = record.syllabusText || '';
        if (text.length > 50) {
            syllabusTd.textContent = text.substring(0, 50) + '...';
            syllabusTd.title = text;
        } else {
            syllabusTd.textContent = text;
        }
        row.appendChild(syllabusTd);

        const actionsTd = document.createElement('td');
        if (record.fileId) {
            const downloadBtn = document.createElement('button');
            downloadBtn.innerHTML = '📥';
            downloadBtn.title = 'Download from Drive';
            downloadBtn.style.cssText = 'margin: 2px; padding: 4px 8px; font-size: 12px; border: none; border-radius: 4px; background: #007bff; color: white; cursor: pointer;';
            downloadBtn.onclick = () => downloadFile(record.fileId, record.fileName);

            const viewBtn = document.createElement('button');
            viewBtn.innerHTML = '👁️';
            viewBtn.title = 'View in Drive (opens in new tab)';
            viewBtn.style.cssText = 'margin: 2px; padding: 4px 8px; font-size: 12px; border: none; border-radius: 4px; background: #6c757d; color: white; cursor: pointer;';
            viewBtn.onclick = () => viewFile(record.fileId);

            actionsTd.appendChild(downloadBtn);
            actionsTd.appendChild(viewBtn);
        } else {
            actionsTd.innerHTML = '<span style="color: #6c757d; font-style: italic;">No file</span>';
        }
        row.appendChild(actionsTd);

        tbody.appendChild(row);
    });
}

// ── Navigation ───────────────────────────────────────────────────────────────
function showLogin() {
    hideAllContainers();
    document.getElementById('loginContainer').classList.remove('hidden');
    setTimeout(() => document.getElementById('loginUserID').focus(), 100);
}

function showRegister() {
    hideAllContainers();
    document.getElementById('registerContainer').classList.remove('hidden');
    setTimeout(() => document.getElementById('regUserID').focus(), 100);
}

function showAccessCode() {
    hideAllContainers();
    document.getElementById('accessCodeContainer').classList.remove('hidden');
    setTimeout(() => document.getElementById('accessCode').focus(), 100);
}

function showApp() {
    hideAllContainers();
    document.getElementById('appContainer').classList.remove('hidden');
    if (currentUser) {
        showAlert(`Welcome back, ${currentUser}! 🎉`, 'success');
    }
}

function hideAllContainers() {
    ['loginContainer', 'registerContainer', 'accessCodeContainer', 'appContainer'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.classList.add('hidden');
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────
function addKeyboardEventListeners() {
    const bindings = [
        ['loginPassword', login],
        ['regPassword', register],
        ['accessCode', checkAccessCode]
    ];
    bindings.forEach(([id, handler]) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keypress', e => {
                if (e.key === 'Enter') handler();
            });
        }
    });
}

async function initializeApp() {
    const clicks = [
        ['loginBtn', login],
        ['registerBtn', register],
        ['showRegisterBtn', showRegister],
        ['showLoginBtn', showLogin],
        ['checkAccessBtn', checkAccessCode],
        ['addRecordBtn', addRecord],
        ['clearRecordsBtn', clearRecords],
        ['refreshRecordsBtn', refreshRecords],
        ['logoutBtn', logout]
    ];
    clicks.forEach(([id, handler]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    });

    addKeyboardEventListeners();

    const savedUser = localStorage.getItem('lastUser');
    if (savedUser) document.getElementById('loginUserID').value = savedUser;

    showLogin();

    if (!apiConfigured()) {
        showAlert('⚠️ Not configured: paste your Apps Script web app URL into config.js', 'error');
        return;
    }

    await resumeSession();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

window.addEventListener('error', event => {
    console.error('Global error:', event.error);
});
