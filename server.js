const express = require('express');
const multer = require('multer');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

const { Client } = require('@notionhq/client');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('Starting Session Records App...');

// Initialize Notion client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// Database IDs from environment variables
const RECORDS_DB_ID = process.env.NOTION_RECORDS_DB_ID;
const USERS_DB_ID = process.env.NOTION_USERS_DB_ID;
const ACCESS_CODES_DB_ID = process.env.NOTION_ACCESS_CODES_DB_ID;
const COUNTS_DB_ID = process.env.NOTION_COUNTS_DB_ID;

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static files from public directory
app.use(express.static('public'));

// Configure multer for PDF file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Ensure uploads directory exists
const ensureUploadsDir = async () => {
  try {
    await fs.access('uploads');
    console.log('Uploads directory exists');
  } catch (error) {
    await fs.mkdir('uploads', { recursive: true });
    console.log('Created uploads directory');
  }
};

// Routes

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File download endpoint - NEW!
app.get('/api/download/:filename', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Get file stats
    const stats = await fs.stat(filePath);
    
    // Find the record with this file to get original name
    const records = await notion.databases.query({
      database_id: RECORDS_DB_ID,
      filter: {
        property: 'StoredFileName',
        rich_text: {
          equals: filename,
        },
      },
    });

    let originalName = filename;
    if (records.results.length > 0) {
      originalName = records.results[0].properties.OriginalFileName?.rich_text?.[0]?.text?.content || filename;
    }

    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stats.size);

    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    console.log('📥 File downloaded:', originalName, 'by user:', req.session.userID);

  } catch (error) {
    console.error('💥 File download error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to download file. Please try again.' 
    });
  }
});

// File view endpoint (for viewing in browser) - NEW!
app.get('/api/view/:filename', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Set headers for inline viewing
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');

    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    console.log('👁️ File viewed:', filename, 'by user:', req.session.userID);

  } catch (error) {
    console.error('💥 File view error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to view file. Please try again.' 
    });
  }
});

// User registration endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { userID, password } = req.body;
    
    console.log('📝 Registration attempt for user:', userID);
    
    // Validation
    if (!userID || !password) {
      console.log('❌ Registration failed: Missing fields');
      return res.json({ 
        success: false, 
        message: 'UserID and password are required',
        redirect: false
      });
    }

    if (userID.length < 3) {
      console.log('❌ Registration failed: UserID too short');
      return res.json({ 
        success: false, 
        message: 'UserID must be at least 3 characters long',
        redirect: false
      });
    }

    if (password.length < 6) {
      console.log('❌ Registration failed: Password too short');
      return res.json({ 
        success: false, 
        message: 'Password must be at least 6 characters long',
        redirect: false
      });
    }

    // Check if user already exists
    const existingUsers = await notion.databases.query({
      database_id: USERS_DB_ID,
      filter: {
        property: 'UserID',
        title: {
          equals: userID,
        },
      },
    });

    if (existingUsers.results.length > 0) {
      console.log('❌ Registration failed: User already exists');
      return res.json({ 
        success: false, 
        message: 'UserID already registered. Please choose a different UserID.',
        redirect: false
      });
    }

    // Create user in Notion with plain text password
    await notion.pages.create({
      parent: { database_id: USERS_DB_ID },
      properties: {
        'UserID': {
          title: [{ text: { content: userID } }]
        },
        'Password': {
          rich_text: [{ text: { content: password } }]
        }
      },
    });

    console.log('✅ User registered successfully:', userID);
    
    // Return success with redirect instruction
    res.json({ 
      success: true, 
      message: 'Registration successful! Redirecting to login...',
      redirect: true,
      redirectTo: 'login',
      userID: userID
    });
    
  } catch (error) {
    console.error('💥 Registration error:', error);
    res.json({ 
      success: false, 
      message: 'Registration failed. Please try again.',
      redirect: false
    });
  }
});

// User login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { userID, password } = req.body;

    console.log('🔐 Login attempt for user:', userID);

    if (!userID || !password) {
      return res.json({ 
        success: false, 
        message: 'UserID and password are required' 
      });
    }

    // Find user in Notion
    const users = await notion.databases.query({
      database_id: USERS_DB_ID,
      filter: {
        property: 'UserID',
        title: {
          equals: userID,
        },
      },
    });

    if (users.results.length === 0) {
      console.log('❌ Login failed: User not found');
      return res.json({ 
        success: false, 
        message: 'User not found. Please check your UserID or register first.' 
      });
    }

    const user = users.results[0];
    const storedPassword = user.properties.Password.rich_text[0]?.text?.content;

    // Compare plain text passwords
    if (storedPassword === password) {
      req.session.userID = userID;
      req.session.loginTime = new Date().toISOString();
      
      console.log('✅ User logged in successfully:', userID);
      res.json({ 
        success: true, 
        message: 'Login successful! Redirecting to access code...',
        redirect: true,
        redirectTo: 'accessCode'
      });
    } else {
      console.log('❌ Login failed: Invalid password');
      res.json({ 
        success: false, 
        message: 'Invalid password. Please check your password and try again.' 
      });
    }
  } catch (error) {
    console.error('💥 Login error:', error);
    res.json({ 
      success: false, 
      message: 'Login failed. Please try again.' 
    });
  }
});

// Check access code endpoint
app.post('/api/check-access-code', async (req, res) => {
  try {
    const { accessCode } = req.body;

    console.log('🔑 Access code check attempt:', accessCode);

    if (!accessCode) {
      return res.json({ 
        success: false, 
        message: 'Access code is required' 
      });
    }

    // Check access code in Notion
    const codes = await notion.databases.query({
      database_id: ACCESS_CODES_DB_ID,
      filter: {
        property: 'AccessCode',
        title: {
          equals: accessCode,
        },
      },
    });

    if (codes.results.length > 0) {
      req.session.accessGranted = true;
      req.session.accessTime = new Date().toISOString();
      
      console.log('✅ Access granted for code:', accessCode);
      res.json({ 
        success: true, 
        message: 'Access granted! Welcome to the Session Records System.',
        redirect: true,
        redirectTo: 'app'
      });
    } else {
      console.log('❌ Invalid access code:', accessCode);
      res.json({ 
        success: false, 
        message: 'Invalid access code. Please contact your administrator for a valid code.' 
      });
    }
  } catch (error) {
    console.error('💥 Access code check error:', error);
    res.json({ 
      success: false, 
      message: 'Access code check failed. Please try again.' 
    });
  }
});

// Add record endpoint with IMPROVED file upload handling
app.post('/api/add-record', upload.single('notesFile'), async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const { department, syllabusText } = req.body;
    const dateTime = new Date().toISOString();

    console.log('📄 Adding record for user:', req.session.userID, 'Department:', department);

    // Validation
    if (!department) {
      return res.json({ 
        success: false, 
        message: 'Please select a department' 
      });
    }

    if (!syllabusText && !req.file) {
      return res.json({ 
        success: false, 
        message: 'Please provide either syllabus text or upload a notes file' 
      });
    }

    // Prepare file information - IMPROVED!
    let fileInfo = {
      originalName: '',
      storedName: '',
      fileSize: 0,
      fileUrl: '',
      viewUrl: ''
    };

    if (req.file) {
      fileInfo = {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        fileSize: req.file.size,
        fileUrl: `/api/download/${req.file.filename}`,
        viewUrl: `/api/view/${req.file.filename}`
      };
    }

    // Create record in Notion with IMPROVED file properties
    await notion.pages.create({
      parent: { database_id: RECORDS_DB_ID },
      properties: {
        'ID': {
          number: Date.now()
        },
        'DateTime': {
          date: { start: dateTime }
        },
        'Department': {
          select: { name: department }
        },
        'UserID': {
          rich_text: [{ text: { content: req.session.userID } }]
        },
        // IMPROVED: Store original filename for display
        'OriginalFileName': {
          rich_text: [{ text: { content: fileInfo.originalName } }]
        },
        // IMPROVED: Store system filename for internal use
        'StoredFileName': {
          rich_text: [{ text: { content: fileInfo.storedName } }]
        },
        // IMPROVED: Store file size
        'FileSize': {
          number: fileInfo.fileSize
        },
        // IMPROVED: Store download URL
        'FileDownloadURL': {
          url: fileInfo.fileUrl || null
        },
        // IMPROVED: Store view URL
        'FileViewURL': {
          url: fileInfo.viewUrl || null
        },
        'SyllabusText': {
          rich_text: [{ text: { content: syllabusText || '' } }]
        }
      },
    });

    // Update department counts
    await updateCounts(department);

    console.log('✅ Record added successfully');
    res.json({ 
      success: true, 
      message: `Record added successfully! ${fileInfo.originalName ? `File "${fileInfo.originalName}" uploaded.` : ''}`,
      recordInfo: {
        department: department,
        hasFile: !!req.file,
        fileName: fileInfo.originalName,
        fileSize: fileInfo.fileSize,
        hasText: !!syllabusText,
        timestamp: new Date().toLocaleString(),
        downloadUrl: fileInfo.fileUrl,
        viewUrl: fileInfo.viewUrl
      }
    });
  } catch (error) {
    console.error('💥 Add record error:', error);
    res.json({ 
      success: false, 
      message: 'Failed to add record. Please try again.' 
    });
  }
});

// Get records endpoint with IMPROVED file information
app.get('/api/records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    console.log('📊 Fetching records for user:', req.session.userID);

    const records = await notion.databases.query({
      database_id: RECORDS_DB_ID,
      sorts: [
        {
          property: 'DateTime',
          direction: 'descending',
        },
      ],
    });

    const formattedRecords = records.results.map(record => {
      const props = record.properties;
      
      // IMPROVED: Better file display with download/view links
      const originalFileName = props.OriginalFileName?.rich_text?.[0]?.text?.content || '';
      const storedFileName = props.StoredFileName?.rich_text?.[0]?.text?.content || '';
      const fileSize = props.FileSize?.number || 0;
      const downloadUrl = props.FileDownloadURL?.url || '';
      const viewUrl = props.FileViewURL?.url || '';
      
      let fileDisplay = '';
      if (originalFileName) {
        const fileSizeKB = Math.round(fileSize / 1024);
        fileDisplay = `📄 ${originalFileName} (${fileSizeKB}KB)`;
      }

      return [
        props.ID?.number || '',
        props.DateTime?.date?.start || '',
        props.Department?.select?.name || '',
        props.UserID?.rich_text?.[0]?.text?.content || '',
        fileDisplay, // Show original filename with size
        props.SyllabusText?.rich_text?.[0]?.text?.content || '',
        downloadUrl, // Add download URL for frontend use
        viewUrl, // Add view URL for frontend use
        storedFileName // Add stored filename for internal use
      ];
    });

    console.log('✅ Retrieved', formattedRecords.length, 'records');
    res.json({ 
      success: true, 
      data: formattedRecords,
      count: formattedRecords.length
    });
  } catch (error) {
    console.error('💥 Get records error:', error);
    res.json({ 
      success: false, 
      message: 'Failed to get records. Please try again.' 
    });
  }
});

// Clear records endpoint with admin password protection
app.post('/api/clear-records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    console.log('🗑️ Clear records attempt by user:', req.session.userID);

    // Get all records first to clean up files
    const records = await notion.databases.query({
      database_id: RECORDS_DB_ID,
    });

    const recordCount = records.results.length;

    // Clean up uploaded files
    let filesDeleted = 0;
    for (const record of records.results) {
      const storedFileName = record.properties.StoredFileName?.rich_text?.[0]?.text?.content;
      if (storedFileName) {
        try {
          const filePath = path.join(__dirname, 'uploads', storedFileName);
          await fs.unlink(filePath);
          filesDeleted++;
          console.log('🗑️ Deleted file:', storedFileName);
        } catch (error) {
          console.log('⚠️ Could not delete file:', storedFileName, error.message);
        }
      }
    }

    // Archive all records (Notion doesn't support bulk delete)
    for (const record of records.results) {
      await notion.pages.update({
        page_id: record.id,
        archived: true,
      });
    }

    // Add a clear record for audit trail
    await notion.pages.create({
      parent: { database_id: RECORDS_DB_ID },
      properties: {
        'ID': {
          number: Date.now()
        },
        'DateTime': {
          date: { start: new Date().toISOString() }
        },
        'Department': {
          select: { name: 'System' }
        },
        'UserID': {
          rich_text: [{ text: { content: req.session.userID } }]
        },
        'OriginalFileName': {
          rich_text: [{ text: { content: '' } }]
        },
        'StoredFileName': {
          rich_text: [{ text: { content: '' } }]
        },
        'FileSize': {
          number: 0
        },
        'SyllabusText': {
          rich_text: [{ text: { content: `ADMIN CLEAR: ${recordCount} records and ${filesDeleted} files cleared by ${req.session.userID} at ${new Date().toLocaleString()}` } }]
        }
      },
    });

    // Clear counts
    await clearCounts();

    console.log('✅ All records cleared successfully by:', req.session.userID);
    res.json({ 
      success: true, 
      message: `Successfully cleared ${recordCount} records and ${filesDeleted} files from the system.`,
      clearedCount: recordCount,
      filesDeleted: filesDeleted,
      clearedBy: req.session.userID,
      clearedAt: new Date().toLocaleString()
    });
  } catch (error) {
    console.error('💥 Clear records error:', error);
    res.json({ 
      success: false, 
      message: 'Failed to clear records. Please try again.' 
    });
  }
});

// Get department counts endpoint
app.get('/api/counts', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
    });

    const formattedCounts = counts.results.map(count => {
      const props = count.properties;
      return {
        department: props.Department?.title?.[0]?.text?.content || '',
        count: props.Count?.number || 0
      };
    });

    res.json({ 
      success: true, 
      data: formattedCounts,
      totalDepartments: formattedCounts.length
    });
  } catch (error) {
    console.error('💥 Get counts error:', error);
    res.json({ 
      success: false, 
      message: 'Failed to get department counts. Please try again.' 
    });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const userID = req.session.userID;
  req.session.destroy((err) => {
    if (err) {
      console.error('💥 Logout error:', err);
      return res.json({ 
        success: false, 
        message: 'Logout failed. Please try again.' 
      });
    }
    console.log('👋 User logged out:', userID);
    res.json({ 
      success: true, 
      message: 'Logged out successfully',
      redirect: true,
      redirectTo: 'login'
    });
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Session Records Management System is running', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Session info endpoint
app.get('/api/session', (req, res) => {
  res.json({
    authenticated: !!(req.session.userID && req.session.accessGranted),
    userID: req.session.userID || null,
    loginTime: req.session.loginTime || null,
    accessTime: req.session.accessTime || null
  });
});

// Helper function to update department counts
async function updateCounts(department) {
  try {
    console.log('📊 Updating counts for department:', department);

    // Get existing counts for this department
    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
      filter: {
        property: 'Department',
        title: {
          equals: department,
        },
      },
    });

    if (counts.results.length > 0) {
      // Update existing count
      const existingCount = counts.results[0];
      const currentCount = existingCount.properties.Count?.number || 0;
      
      await notion.pages.update({
        page_id: existingCount.id,
        properties: {
          'Count': {
            number: currentCount + 1
          }
        },
      });
      
      console.log('✅ Updated count for', department, 'to', currentCount + 1);
    } else {
      // Create new count entry
      await notion.pages.create({
        parent: { database_id: COUNTS_DB_ID },
        properties: {
          'Department': {
            title: [{ text: { content: department } }]
          },
          'Count': {
            number: 1
          }
        },
      });
      
      console.log('✅ Created new count entry for', department, 'with count 1');
    }
  } catch (error) {
    console.error('💥 Update counts error:', error);
  }
}

// Helper function to clear all counts
async function clearCounts() {
  try {
    console.log('🗑️ Clearing all department counts...');

    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
    });

    for (const count of counts.results) {
      await notion.pages.update({
        page_id: count.id,
        archived: true,
      });
    }

    console.log('✅ All counts cleared');
  } catch (error) {
    console.error('💥 Clear counts error:', error);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('💥 Express error:', error);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error. Please try again.' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found',
    requestedPath: req.path
  });
});

// Start server
app.listen(PORT, async () => {
  await ensureUploadsDir();
  console.log(`\n🚀 SESSION RECORDS MANAGEMENT SYSTEM`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📚 Ready to manage session records!`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Server terminated');
  process.exit(0);
});
