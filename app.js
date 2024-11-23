require('dotenv').config();
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const { Readable } = require('stream');

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Define Mongoose schema and model for messages
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true },
    timestamp: { type: String, required: true },
    sender: { type: String, required: true },
    receiver: { type: String, required: true },
    content: { type: String, required: true },
    replyTo: { type: String, default: null },
});

const Message = mongoose.model('Message', messageSchema);

// Google Drive API setup
const CREDENTIALS_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;

const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

// Socket.IO events
const users = {};

io.on('connection', (socket) => {
    socket.on('join', ({ sender }) => {
        users[sender] = socket.id;
        socket.join(sender);

        // Fetch previous messages for the sender
        Message.find({ $or: [{ sender }, { receiver: sender }] })
            .then(messages => socket.emit('previousMessages', messages))
            .catch(err => console.error('Error fetching previous messages:', err));
    });

    socket.on('message', (data) => {
        const { sender, receiver, content, file, replyTo } = data;
        const newMessage = new Message({
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            sender,
            receiver,
            content: content || file,
            replyTo: replyTo || null,
        });

        newMessage.save()
            .then(() => {
                io.to(sender).emit('receiveMessage', newMessage);
                io.to(receiver).emit('receiveMessage', newMessage);
            })
            .catch(err => console.error('Error saving message:', err));
    });

    socket.on('disconnect', () => {
        for (const [username, id] of Object.entries(users)) {
            if (id === socket.id) {
                delete users[username];
                break;
            }
        }
    });
});

const upload = multer({ storage: multer.memoryStorage() });

// Google Drive upload function
const uploadToGoogleDrive = async (file, fileName) => {
    try {
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const fileStream = new Readable();
        fileStream.push(file.buffer);
        fileStream.push(null);

        const fileMetadata = {
            name: fileName,
            parents: [folderId],
        };

        const media = {
            mimeType: file.mimetype,
            body: fileStream,
        };

        const driveFile = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
        });

        return driveFile.data;
    } catch (error) {
        console.error('Error uploading file to Google Drive:', error);
        throw new Error('Error uploading file to Google Drive');
    }
};

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (file) {
        try {
            const result = await uploadToGoogleDrive(file, file.originalname);
            const fileUrl = `https://drive.google.com/file/d/${result.id}/view`;
            res.json({ success: true, fileUrl: fileUrl });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error uploading file', error: error.message });
        }
    } else {
        res.status(400).json({ success: false, message: 'No file uploaded' });
    }
});

// Serve the file from Google Drive
app.get('/file/:fileId', async (req, res) => {
    const { fileId } = req.params;

    try {
        const file = await drive.files.get({
            fileId: fileId,
            alt: 'media',
        }, { responseType: 'stream' });

        res.setHeader('Content-Type', file.headers['content-type']);
        file.data.pipe(res);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching file' });
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
