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

// User registration endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { userID, password } = req.body;
    
    console.log('Registration attempt for user:', userID);
    
    // Validation
    if (!userID || !password) {
      return res.json({ success: false, message: 'UserID and password are required' });
    }

    if (userID.length < 3) {
      return res.json({ success: false, message: 'UserID must be at least 3 characters long' });
    }

    if (password.length < 6) {
      return res.json({ success: false, message: 'Password must be at least 6 characters long' });
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
      return res.json({ success: false, message: 'UserID already registered' });
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

    console.log('User registered successfully:', userID);
    res.json({ success: true, message: 'Registration successful!' });
  } catch (error) {
    console.error('Registration error:', error);
    res.json({ success: false, message: 'Registration failed' });
  }
});

// User login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { userID, password } = req.body;

    console.log('Login attempt for user:', userID);

    if (!userID || !password) {
      return res.json({ success: false, message: 'UserID and password are required' });
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
      return res.json({ success: false, message: 'User not found' });
    }

    const user = users.results[0];
    const storedPassword = user.properties.Password.rich_text[0]?.text?.content;

    // Compare plain text passwords
    if (storedPassword === password) {
      req.session.userID = userID;
      console.log('User logged in successfully:', userID);
      res.json({ success: true, message: 'Login successful!' });
    } else {
      res.json({ success: false, message: 'Invalid password' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.json({ success: false, message: 'Login failed' });
  }
});

// Check access code endpoint
app.post('/api/check-access-code', async (req, res) => {
  try {
    const { accessCode } = req.body;

    console.log('Access code check attempt:', accessCode);

    if (!accessCode) {
      return res.json({ success: false, message: 'Access code is required' });
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
      console.log('Access granted for code:', accessCode);
      res.json({ success: true, message: 'Access granted!' });
    } else {
      res.json({ success: false, message: 'Invalid access code' });
    }
  } catch (error) {
    console.error('Access code check error:', error);
    res.json({ success: false, message: 'Access code check failed' });
  }
});

// Add record endpoint with file upload
app.post('/api/add-record', upload.single('notesFile'), async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

    const { department, syllabusText } = req.body;
    const notesFileName = req.file ? req.file.filename : '';
    const dateTime = new Date().toISOString();

    console.log('Adding record for user:', req.session.userID, 'Department:', department);

    // Validation
    if (!department) {
      return res.json({ success: false, message: 'Department is required' });
    }

    // Create record in Notion
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
        'NotesFile': {
          rich_text: [{ text: { content: notesFileName || '' } }]
        },
        'SyllabusText': {
          rich_text: [{ text: { content: syllabusText || '' } }]
        }
      },
    });

    // Update department counts
    await updateCounts(department);

    console.log('Record added successfully');
    res.json({ success: true, message: 'Record added successfully!' });
  } catch (error) {
    console.error('Add record error:', error);
    res.json({ success: false, message: 'Failed to add record' });
  }
});

// Get records endpoint
app.get('/api/records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

    console.log('Fetching records for user:', req.session.userID);

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
      return [
        props.ID?.number || '',
        props.DateTime?.date?.start || '',
        props.Department?.select?.name || '',
        props.UserID?.rich_text?.[0]?.text?.content || '',
        props.NotesFile?.rich_text?.[0]?.text?.content || '',
        props.SyllabusText?.rich_text?.[0]?.text?.content || ''
      ];
    });

    console.log('Retrieved', formattedRecords.length, 'records');
    res.json({ success: true, data: formattedRecords });
  } catch (error) {
    console.error('Get records error:', error);
    res.json({ success: false, message: 'Failed to get records' });
  }
});

// Clear records endpoint with admin password protection
app.post('/api/clear-records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

    const { adminPassword } = req.body;

    console.log('Clear records attempt by user:', req.session.userID);

    // Check admin password
    if (!adminPassword) {
      return res.json({ success: false, message: 'Admin password required' });
    }

    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      console.log('Invalid admin password attempt');
      return res.json({ success: false, message: 'Invalid admin password' });
    }

    console.log('Admin password verified, clearing records...');

    // Get all records
    const records = await notion.databases.query({
      database_id: RECORDS_DB_ID,
    });

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
        'NotesFile': {
          rich_text: [{ text: { content: '' } }]
        },
        'SyllabusText': {
          rich_text: [{ text: { content: `All records cleared by ${req.session.userID} with admin password verification at ${new Date().toLocaleString()}` } }]
        }
      },
    });

    // Clear counts
    await clearCounts();

    console.log('All records cleared successfully by:', req.session.userID);
    res.json({ success: true, message: 'All records cleared successfully!' });
  } catch (error) {
    console.error('Clear records error:', error);
    res.json({ success: false, message: 'Failed to clear records' });
  }
});

// Get department counts endpoint
app.get('/api/counts', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
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

    res.json({ success: true, data: formattedCounts });
  } catch (error) {
    console.error('Get counts error:', error);
    res.json({ success: false, message: 'Failed to get counts' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.json({ success: false, message: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Helper function to update department counts
async function updateCounts(department) {
  try {
    console.log('Updating counts for department:', department);

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
      
      console.log('Updated count for', department, 'to', currentCount + 1);
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
      
      console.log('Created new count entry for', department, 'with count 1');
    }
  } catch (error) {
    console.error('Update counts error:', error);
  }
}

// Helper function to clear all counts
async function clearCounts() {
  try {
    console.log('Clearing all department counts...');

    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
    });

    for (const count of counts.results) {
      await notion.pages.update({
        page_id: count.id,
        archived: true,
      });
    }

    console.log('All counts cleared');
  } catch (error) {
    console.error('Clear counts error:', error);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found' 
  });
});

// Start server
app.listen(PORT, async () => {
  await ensureUploadsDir();
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 App URL: http://localhost:${PORT}`);
  console.log(`📚 Session Records Management System Ready!`);
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
