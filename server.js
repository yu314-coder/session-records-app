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

// Database IDs (you'll need to create these in Notion)
const RECORDS_DB_ID = process.env.NOTION_RECORDS_DB_ID;
const USERS_DB_ID = process.env.NOTION_USERS_DB_ID;
const ACCESS_CODES_DB_ID = process.env.NOTION_ACCESS_CODES_DB_ID;
const COUNTS_DB_ID = process.env.NOTION_COUNTS_DB_ID;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static files
app.use(express.static('public'));

// Configure multer for file uploads
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
  } catch (error) {
    await fs.mkdir('uploads', { recursive: true });
  }
};

// Routes

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// User registration
app.post('/api/register', async (req, res) => {
  try {
    const { userID, password } = req.body;
    
    if (!userID || !password) {
      return res.json({ success: false, message: 'UserID and password are required' });
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

    // Create user in Notion (store plain text password)
    await notion.pages.create({
      parent: { database_id: USERS_DB_ID },
      properties: {
        'Name': {
          title: [{ text: { content: userID } }]
        },
        'Password': {
          rich_text: [{ text: { content: password } }]  // Store plain text password
        }
      },
    });

    res.json({ success: true, message: 'Registered' });
  } catch (error) {
    console.error('Registration error:', error);
    res.json({ success: false, message: 'Registration failed' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { userID, password } = req.body;

    if (!userID || !password) {
      return res.json({ success: false, message: 'UserID and password are required' });
    }

    // Find user in Notion
    const users = await notion.databases.query({
      database_id: USERS_DB_ID,
      filter: {
        property: 'Name',
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
      res.json({ success: true, message: 'Success' });
    } else {
      res.json({ success: false, message: 'Login failed' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.json({ success: false, message: 'Login failed' });
  }
});

// Check access code
app.post('/api/check-access-code', async (req, res) => {
  try {
    const { accessCode } = req.body;

    if (!accessCode) {
      return res.json({ success: false, message: 'Access code is required' });
    }

    // Check access code in Notion
    const codes = await notion.databases.query({
      database_id: ACCESS_CODES_DB_ID,
      filter: {
        property: 'Name',
        title: {
          equals: accessCode,
        },
      },
    });

    if (codes.results.length > 0) {
      req.session.accessGranted = true;
      res.json({ success: true, message: 'Success' });
    } else {
      res.json({ success: false, message: 'Invalid Access Code' });
    }
  } catch (error) {
    console.error('Access code check error:', error);
    res.json({ success: false, message: 'Access code check failed' });
  }
});

// Add record
app.post('/api/add-record', upload.single('notesFile'), async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

    const { department, syllabusText } = req.body;
    const notesFileName = req.file ? req.file.filename : '';
    const dateTime = new Date().toISOString();

    // Create record in Notion
    await notion.pages.create({
      parent: { database_id: RECORDS_DB_ID },
      properties: {
        'Name': {
          title: [{ text: { content: `Record-${Date.now()}` } }]
        },
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

    // Update counts
    await updateCounts(department);

    res.json({ success: true, message: 'Record added' });
  } catch (error) {
    console.error('Add record error:', error);
    res.json({ success: false, message: 'Failed to add record' });
  }
});

// Get records
app.get('/api/records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

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

    res.json({ success: true, data: formattedRecords });
  } catch (error) {
    console.error('Get records error:', error);
    res.json({ success: false, message: 'Failed to get records' });
  }
});

// Clear records
app.post('/api/clear-records', async (req, res) => {
  try {
    if (!req.session.userID || !req.session.accessGranted) {
      return res.json({ success: false, message: 'Not authenticated' });
    }

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

    // Add clear record
    await notion.pages.create({
      parent: { database_id: RECORDS_DB_ID },
      properties: {
        'Name': {
          title: [{ text: { content: `Cleared-${Date.now()}` } }]
        },
        'ID': {
          number: Date.now()
        },
        'DateTime': {
          date: { start: new Date().toISOString() }
        },
        'Department': {
          select: { name: 'Cleared All' }
        },
        'UserID': {
          rich_text: [{ text: { content: req.session.userID } }]
        },
        'NotesFile': {
          rich_text: [{ text: { content: '' } }]
        },
        'SyllabusText': {
          rich_text: [{ text: { content: `Cleared by ${req.session.userID}` } }]
        }
      },
    });

    // Clear counts
    await clearCounts();

    res.json({ success: true, message: 'All records cleared' });
  } catch (error) {
    console.error('Clear records error:', error);
    res.json({ success: false, message: 'Failed to clear records' });
  }
});

// Helper function to update counts
async function updateCounts(department) {
  try {
    // Get existing counts
    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
      filter: {
        property: 'Name',
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
    } else {
      // Create new count entry
      await notion.pages.create({
        parent: { database_id: COUNTS_DB_ID },
        properties: {
          'Name': {
            title: [{ text: { content: department } }]
          },
          'Count': {
            number: 1
          }
        },
      });
    }
  } catch (error) {
    console.error('Update counts error:', error);
  }
}

// Helper function to clear counts
async function clearCounts() {
  try {
    const counts = await notion.databases.query({
      database_id: COUNTS_DB_ID,
    });

    for (const count of counts.results) {
      await notion.pages.update({
        page_id: count.id,
        archived: true,
      });
    }
  } catch (error) {
    console.error('Clear counts error:', error);
  }
}

// Start server
app.listen(PORT, async () => {
  await ensureUploadsDir();
  console.log(`Server running on port ${PORT}`);
});
