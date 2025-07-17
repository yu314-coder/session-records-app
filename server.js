const express = require('express');
const multer = require('multer');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const FormData = require('form-data');
const fetch = require('node-fetch');
require('dotenv').config();

const { Client } = require('@notionhq/client');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('Starting Session Records App with Notion File Upload...');

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

// Configure multer for temporary file storage (before uploading to Notion)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'temp/');
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
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit (Notion's limit for direct upload)
});

// Ensure temp directory exists
const ensureTempDir = async () => {
  try {
    await fs.access('temp');
    console.log('Temp directory exists');
  } catch (error) {
    await fs.mkdir('temp', { recursive: true });
    console.log('Created temp directory');
  }
};

// Helper function to upload file to Notion
async function uploadFileToNotion(filePath, originalFilename) {
  try {
    console.log('📤 Starting Notion file upload for:', originalFilename);

    // Step 1: Create file upload in Notion (FIXED ENDPOINT)
    const createUploadResponse = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filename: originalFilename
      })
    });

    if (!createUploadResponse.ok) {
      const errorText = await createUploadResponse.text();
      throw new Error(`Failed to create file upload: ${createUploadResponse.status} - ${errorText}`);
    }

    const uploadData = await createUploadResponse.json();
    console.log('✅ File upload created with ID:', uploadData.id);
    console.log('📍 Upload URL:', uploadData.upload_url);

    // Step 2: Upload file content to Notion's upload URL
    const fileBuffer = await fs.readFile(filePath);
    
    const uploadFormData = new FormData();
    uploadFormData.append('file', fileBuffer, {
      filename: originalFilename,
      contentType: 'application/pdf'
    });

    const uploadResponse = await fetch(uploadData.upload_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28'
        // Don't set Content-Type - let FormData handle it with boundary
      },
      body: uploadFormData
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Failed to upload file content: ${uploadResponse.status} - ${errorText}`);
    }

    console.log('✅ File content uploaded to Notion successfully');

    // Clean up temporary file
    try {
      await fs.unlink(filePath);
      console.log('🗑️ Temporary file cleaned up');
    } catch (error) {
      console.log('⚠️ Could not clean up temp file:', error.message);
    }

    return {
      fileUploadId: uploadData.id,
      originalName: originalFilename,
      success: true
    };

  } catch (error) {
    console.error('💥 Notion file upload error:', error);
    
    // Clean up temporary file on error
    try {
      await fs.unlink(filePath);
    } catch (cleanupError) {
      console.log('⚠️ Could not clean up temp file after error:', cleanupError.message);
    }

    throw error;
  }
}

// Helper function to get fresh file URL from Notion
async function getNotionFileUrl(recordId) {
  try {
    const response = await notion.pages.retrieve({
      page_id: recordId
    });

    const fileProperty = response.properties.NotionFile;
    if (fileProperty && fileProperty.files && fileProperty.files.length > 0) {
      const file = fileProperty.files[0];
      
      // Handle both file_upload and file types
      if (file.type === 'file_upload') {
        // For file_upload type, we need to get the actual file info
        // The file should transition to 'file' type after successful upload
        console.log('⚠️ File is still in file_upload state, may need to wait or check status');
        return {
          url: null,
          expiryTime: null,
          filename: file.name || 'file.pdf',
          isReady: false
        };
      } else if (file.type === 'file' && file.file) {
        return {
          url: file.file.url,
          expiryTime: file.file.expiry_time,
          filename: file.name || 'file.pdf',
          isReady: true
        };
      }
    }

    return null;
  } catch (error) {
    console.error('💥 Error getting Notion file URL:', error);
    return null;
  }
}

// Routes

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File download endpoint - Gets fresh URL from Notion
app.get('/api/download/:recordId', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const recordId = req.params.recordId;
    console.log('📥 Getting download URL for record:', recordId);

    const fileInfo = await getNotionFileUrl(recordId);
    
    if (!fileInfo) {
      return res.status(404).json({
        success: false,
        message: 'File not found or no longer available'
      });
    }

    if (!fileInfo.isReady) {
      return res.status(202).json({
        success: false,
        message: 'File is still being processed by Notion. Please try again in a few moments.',
        processing: true
      });
    }

    if (!fileInfo.url) {
      return res.status(404).json({
        success: false,
        message: 'File URL not available. The file may have expired or been moved.'
      });
    }

    // Return the fresh Notion URL for download
    res.json({
      success: true,
      downloadUrl: fileInfo.url,
      filename: fileInfo.filename,
      expiryTime: fileInfo.expiryTime,
      message: 'File URL retrieved successfully'
    });

    console.log('✅ File URL retrieved for download:', fileInfo.filename);

  } catch (error) {
    console.error('💥 File download error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get download URL. Please try again.' 
    });
  }
});

// File view endpoint - Gets fresh URL from Notion  
app.get('/api/view/:recordId', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.status(401).json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    const recordId = req.params.recordId;
    console.log('👁️ Getting view URL for record:', recordId);

    const fileInfo = await getNotionFileUrl(recordId);
    
    if (!fileInfo) {
      return res.status(404).json({
        success: false,
        message: 'File not found or no longer available'
      });
    }

    if (!fileInfo.isReady) {
      return res.status(202).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>⏳ File Processing</h2>
            <p>Your file is still being processed by Notion.</p>
            <p>Please try again in a few moments.</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>
      `);
    }

    if (!fileInfo.url) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>❌ File Not Available</h2>
            <p>The file URL is not available. The file may have expired or been moved.</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>
      `);
    }

    // Redirect to Notion's file URL for viewing
    res.redirect(fileInfo.url);

    console.log('✅ Redirecting to file view:', fileInfo.filename);

  } catch (error) {
    console.error('💥 File view error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>💥 Error</h2>
          <p>Failed to view file. Please try again.</p>
          <button onclick="window.close()">Close</button>
        </body>
      </html>
    `);
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

// Add record endpoint with Notion file upload
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

    let notionFileInfo = null;

    // Upload file to Notion if provided
    if (req.file) {
      try {
        console.log('📤 Uploading file to Notion:', req.file.originalname);
        notionFileInfo = await uploadFileToNotion(req.file.path, req.file.originalname);
      } catch (error) {
        console.error('💥 Failed to upload file to Notion:', error);
        return res.json({ 
          success: false, 
          message: 'Failed to upload file to Notion. Please try again.' 
        });
      }
    }

    // Prepare properties for Notion database
    const properties = {
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
      'SyllabusText': {
        rich_text: [{ text: { content: syllabusText || '' } }]
      }
    };

    // Add file information if uploaded
    if (notionFileInfo) {
      properties.NotionFile = {
        files: [{
          type: 'file_upload',
          file_upload: {
            id: notionFileInfo.fileUploadId
          },
          name: notionFileInfo.originalName
        }]
      };
      
      properties.OriginalFileName = {
        rich_text: [{ text: { content: notionFileInfo.originalName } }]
      };
      
      properties.FileSize = {
        number: req.file.size
      };
    }

    // Create record in Notion
    const record = await notion.pages.create({
      parent: { database_id: RECORDS_DB_ID },
      properties: properties
    });

    // Update department counts
    await updateCounts(department);

    console.log('✅ Record added successfully with ID:', record.id);
    res.json({ 
      success: true, 
      message: `Record added successfully! ${notionFileInfo ? `File "${notionFileInfo.originalName}" uploaded to Notion.` : ''}`,
      recordInfo: {
        recordId: record.id,
        department: department,
        hasFile: !!notionFileInfo,
        fileName: notionFileInfo?.originalName,
        fileSize: req.file?.size,
        hasText: !!syllabusText,
        timestamp: new Date().toLocaleString()
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

// Get records endpoint with Notion file information
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
      
      // Get file information from Notion
      const originalFileName = props.OriginalFileName?.rich_text?.[0]?.text?.content || '';
      const fileSize = props.FileSize?.number || 0;
      const notionFiles = props.NotionFile?.files || [];
      
      let fileDisplay = '';
      let hasFile = false;
      
      if (originalFileName && notionFiles.length > 0) {
        const fileSizeKB = Math.round(fileSize / 1024);
        fileDisplay = `📄 ${originalFileName} (${fileSizeKB}KB)`;
        hasFile = true;
      }

      return [
        props.ID?.number || '',
        props.DateTime?.date?.start || '',
        props.Department?.select?.name || '',
        props.UserID?.rich_text?.[0]?.text?.content || '',
        fileDisplay,
        props.SyllabusText?.rich_text?.[0]?.text?.content || '',
        record.id, // Record ID for file access
        hasFile // Boolean to show/hide action buttons
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

// Clear records endpoint
app.post('/api/clear-records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ 
        success: false, 
        message: 'Not authenticated. Please login first.' 
      });
    }

    console.log('🗑️ Clear records attempt by user:', req.session.userID);

    // Get all records
    const records = await notion.databases.query({
      database_id: RECORDS_DB_ID,
    });

    const recordCount = records.results.length;

    // Archive all records (Notion doesn't support bulk delete)
    // Note: Files in Notion will remain but won't be accessible through these records
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
        'SyllabusText': {
          rich_text: [{ text: { content: `ADMIN CLEAR: ${recordCount} records cleared by ${req.session.userID} at ${new Date().toLocaleString()}. Files remain in Notion but are no longer linked.` } }]
        }
      },
    });

    // Clear counts
    await clearCounts();

    console.log('✅ All records cleared successfully by:', req.session.userID);
    res.json({ 
      success: true, 
      message: `Successfully cleared ${recordCount} records. Files remain in Notion storage.`,
      clearedCount: recordCount,
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
    message: 'Session Records Management System with Notion File Upload is running', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
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
  await ensureTempDir();
  console.log(`\n🚀 SESSION RECORDS MANAGEMENT SYSTEM WITH NOTION FILE UPLOAD`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📚 Files uploaded directly to Notion!`);
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
