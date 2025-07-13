// Session Records Management System - Client Side JavaScript
// Global variables
let currentUser = null;
let isLoading = false;

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

// Initialize application
function initializeApp() {
    console.log('Initializing Session Records App...');
    showLogin();
    
    // Add keyboard event listeners
    addKeyboardEventListeners();
    
    // Check if user was previously logged in (optional)
    // Note: This is just for UX, server-side session is the real auth
    checkPreviousSession();
}

// Add keyboard event listeners for better UX
function addKeyboardEventListeners() {
    // Enter key support for login form
    document.getElementById('loginPassword').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            login();
        }
    });
    
    // Enter key support for registration form
    document.getElementById('regPassword').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            register();
        }
    });
    
    // Enter key support for access code
    document.getElementById('accessCode').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            checkAccessCode();
        }
    });
}

// Check if user has a previous session (client-side only)
function checkPreviousSession() {
    const savedUser = localStorage.getItem('lastUser');
    if (savedUser) {
        document.getElementById('loginUserID').value = savedUser;
    }
}

// Utility function to show alerts with animation
function showAlert(message, type = 'success') {
    const alertContainer = document.getElementById('alertContainer');
    
    // Clear existing alerts
    alertContainer.innerHTML = '';
    
    // Create new alert
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    // Add to container
    alertContainer.appendChild(alertDiv);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.style.opacity = '0';
            alertDiv.style.transform = 'translateY(-10px)';
            setTimeout(() => {
                if (alertDiv.parentNode) {
                    alertContainer.removeChild(alertDiv);
                }
            }, 300);
        }
    }, 5000);
}

// Set loading state for buttons
function setLoadingState(buttonElement, isLoading) {
    if (isLoading) {
        buttonElement.disabled = true;
        buttonElement.classList.add('loading');
        buttonElement.setAttribute('data-original-text', buttonElement.textContent);
        buttonElement.textContent = 'Loading...';
    } else {
        buttonElement.disabled = false;
        buttonElement.classList.remove('loading');
        buttonElement.textContent = buttonElement.getAttribute('data-original-text') || buttonElement.textContent;
    }
}

// Validate email format (basic validation)
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Validate password strength (basic validation)
function isValidPassword(password) {
    return password.length >= 6; // Minimum 6 characters
}

// Authentication functions
async function register() {
    if (isLoading) return;
    
    const userID = document.getElementById('regUserID').value.trim();
    const password = document.getElementById('regPassword').value;
    const registerBtn = document.querySelector('#registerContainer button');

    // Client-side validation
    if (!userID || !password) {
        showAlert('Please fill in all fields', 'error');
        return;
    }

    if (userID.length < 3) {
        showAlert('User ID must be at least 3 characters long', 'error');
        return;
    }

    if (!isValidPassword(password)) {
        showAlert('Password must be at least 6 characters long', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(registerBtn, true);

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ userID, password })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        showAlert(result.message, result.success ? 'success' : 'error');

        if (result.success) {
            // Clear form
            document.getElementById('regUserID').value = '';
            document.getElementById('regPassword').value = '';
            
            // Save user ID for convenience
            localStorage.setItem('lastUser', userID);
            
            // Switch to login after successful registration
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
    const loginBtn = document.querySelector('#loginContainer button');

    // Client-side validation
    if (!userID || !password) {
        showAlert('Please fill in all fields', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(loginBtn, true);

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ userID, password })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            currentUser = userID;
            localStorage.setItem('lastUser', userID);
            
            // Clear password field for security
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
    const submitBtn = document.querySelector('#accessCodeContainer button');

    if (!accessCode) {
        showAlert('Please enter access code', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(submitBtn, true);

    try {
        const response = await fetch('/api/check-access-code', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ accessCode })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

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

async function saveAccessCode() {
    if (isLoading) return;
    
    const accessCode = document.getElementById('accessCode').value.trim();
    const saveBtn = document.querySelectorAll('#accessCodeContainer button')[1];

    if (!accessCode) {
        showAlert('Please enter access code to save', 'error');
        return;
    }

    if (accessCode.length < 4) {
        showAlert('Access code must be at least 4 characters long', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(saveBtn, true);

    try {
        const response = await fetch('/api/save-access-code', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ accessCode })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        showAlert(result.message, result.success ? 'success' : 'error');
    } catch (error) {
        console.error('Save access code error:', error);
        showAlert('Failed to save access code. Please try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(saveBtn, false);
    }
}

// Main application functions
async function addRecord() {
    if (isLoading) return;
    
    const department = document.getElementById('department').value;
    const notesFile = document.getElementById('notesFile').files[0];
    const syllabusText = document.getElementById('syllabusText').value.trim();
    const addBtn = document.querySelector('#appContainer button');

    // Client-side validation
    if (!department) {
        showAlert('Please select a department', 'error');
        return;
    }

    // Validate file if provided
    if (notesFile) {
        if (notesFile.type !== 'application/pdf') {
            showAlert('Only PDF files are allowed', 'error');
            return;
        }
        
        if (notesFile.size > 10 * 1024 * 1024) { // 10MB limit
            showAlert('File size must be less than 10MB', 'error');
            return;
        }
    }

    // At least one of notes file or syllabus text should be provided
    if (!notesFile && !syllabusText) {
        showAlert('Please provide either a notes file or syllabus text', 'error');
        return;
    }

    isLoading = true;
    setLoadingState(addBtn, true);

    const formData = new FormData();
    formData.append('department', department);
    formData.append('syllabusText', syllabusText);
    
    if (notesFile) {
        formData.append('notesFile', notesFile);
    }

    try {
        const response = await fetch('/api/add-record', {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: formData
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        showAlert(result.message, result.success ? 'success' : 'error');

        if (result.success) {
            // Clear form
            document.getElementById('notesFile').value = '';
            document.getElementById('syllabusText').value = '';
            
            // Refresh records table
            setTimeout(() => refreshRecords(), 500);
        }
    } catch (error) {
        console.error('Add record error:', error);
        showAlert('Failed to add record. Please try again.', 'error');
    } finally {
        isLoading = false;
        setLoadingState(addBtn, false);
    }
}

async function refreshRecords() {
    if (isLoading) return;
    
    const refreshBtn = document.querySelectorAll('#appContainer button')[2];
    
    try {
        setLoadingState(refreshBtn, true);
        
        const response = await fetch('/api/records', {
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            updateRecordsTable(result.data);
            showAlert('Records refreshed successfully', 'success');
        } else {
            showAlert('Failed to load records: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('Refresh records error:', error);
        showAlert('Failed to load records. Please check your connection.', 'error');
    } finally {
        setLoadingState(refreshBtn, false);
    }
}

async function clearRecords() {
    // Double confirmation for destructive action
    if (!confirm('⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL records.\nThis action CANNOT be undone!\n\nType "DELETE" to confirm.')) {
        return;
    }
    
    const userConfirmation = prompt('Type "DELETE" to confirm:');
    if (userConfirmation !== 'DELETE') {
        showAlert('Action cancelled', 'error');
        return;
    }

    if (isLoading) return;
    
    const clearBtn = document.querySelectorAll('#appContainer button')[1];
    isLoading = true;
    setLoadingState(clearBtn, true);

    try {
        const response = await fetch('/api/clear-records', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
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

// Update the records table with data
function updateRecordsTable(records) {
    const tbody = document.querySelector('#recordsTable tbody');
    
    if (!tbody) {
        console.error('Records table body not found');
        return;
    }
    
    // Clear existing rows
    tbody.innerHTML = '';

    if (!records || records.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="6" style="text-align: center; padding: 30px; color: #6c757d; font-style: italic;">📋 No records found. Add your first record above!</td>';
        tbody.appendChild(row);
        return;
    }

    // Add data rows
    records.forEach((record, index) => {
        const row = document.createElement('tr');
        row.style.animationDelay = `${index * 0.1}s`;
        
        record.forEach((cell, cellIndex) => {
            const td = document.createElement('td');
            
            if (cellIndex === 1 && cell) {
                // Format datetime
                const date = new Date(cell);
                td.textContent = date.toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else if (cellIndex === 4 && cell) {
                // Notes file - show filename with download icon
                td.innerHTML = `📄 ${cell}`;
                td.style.color = '#007bff';
                td.style.cursor = 'pointer';
                td.title = 'Click to view file details';
            } else if (cellIndex === 5 && cell && cell.length > 50) {
                // Truncate long syllabus text
                td.textContent = cell.substring(0, 50) + '...';
                td.title = cell; // Show full text on hover
            } else {
                td.textContent = cell || '';
            }
            
            row.appendChild(td);
        });
        
        tbody.appendChild(row);
    });
}

// Navigation functions
function showLogin() {
    hideAllContainers();
    document.getElementById('loginContainer').classList.remove('hidden');
    document.getElementById('loginUserID').focus();
}

function showRegister() {
    hideAllContainers();
    document.getElementById('registerContainer').classList.remove('hidden');
    document.getElementById('regUserID').focus();
}

function showAccessCode() {
    hideAllContainers();
    document.getElementById('accessCodeContainer').classList.remove('hidden');
    document.getElementById('accessCode').focus();
}

function showApp() {
    hideAllContainers();
    document.getElementById('appContainer').classList.remove('hidden');
    
    // Welcome message
    if (currentUser) {
        showAlert(`Welcome back, ${currentUser}! 🎉`, 'success');
    }
}

function hideAllContainers() {
    const containers = [
        'loginContainer', 
        'registerContainer', 
        'accessCodeContainer', 
        'appContainer'
    ];
    
    containers.forEach(containerId => {
        document.getElementById(containerId).classList.add('hidden');
    });
}

// Logout function
function logout() {
    if (confirm('Are you sure you want to logout?')) {
        currentUser = null;
        // Clear sensitive form data
        document.getElementById('loginPassword').value = '';
        document.getElementById('accessCode').value = '';
        
        showAlert('Logged out successfully', 'success');
        setTimeout(() => showLogin(), 1000);
    }
}

// Export functions for potential external use
window.SessionRecordsApp = {
    login,
    register,
    logout,
    addRecord,
    refreshRecords,
    clearRecords,
    showLogin,
    showRegister,
    showAccessCode,
    showApp
};

// Error handling for uncaught errors
window.addEventListener('error', function(event) {
    console.error('Global error:', event.error);
    showAlert('An unexpected error occurred. Please refresh the page and try again.', 'error');
});

// Handle network connectivity
window.addEventListener('online', function() {
    showAlert('Connection restored! 🌐', 'success');
});

window.addEventListener('offline', function() {
    showAlert('Connection lost. Please check your internet connection. 📡', 'error');
});

console.log('Session Records App JavaScript loaded successfully! 🚀');
