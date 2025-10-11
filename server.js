// housing-hub-backend/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const sgTransport = require('nodemailer-sendgrid-transport');
const mongoose = require('mongoose');
const connectDB = require('./db');

const app = express();
connectDB();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key-change-this";

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const otpStore = {};

// --- Mongoose Schemas ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    user_type: { type: String, enum: ['student', 'landlord'], required: true },
}, { timestamps: true });

const PropertySchema = new mongoose.Schema({
    landlord_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    description: String,
    address: { type: String, required: true },
    city: { type: String, required: true },
    price: { type: Number, required: true },
    property_type: { type: String, enum: ['apartment', 'house', 'room'], required: true },
    bedrooms: Number,
    bathrooms: Number,
    amenities: String,
    image_url: String, // Main display image
    images: [String],  // Gallery images
    floor_plan_url: String,
    virtual_tour_url: String,
    lat: Number,
    lng: Number,
}, { timestamps: true });

const ReviewSchema = new mongoose.Schema({
    property_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: String,
}, { timestamps: true });
ReviewSchema.index({ property_id: 1, user_id: 1 }, { unique: true });

const FavoriteSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    property_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
}, { timestamps: true });
FavoriteSchema.index({ user_id: 1, property_id: 1 }, { unique: true });

const ConversationSchema = new mongoose.Schema({
    property_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    landlord_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
    conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
}, { timestamps: true });

const PropertyViewSchema = new mongoose.Schema({
    property_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
}, { timestamps: true });

// --- Mongoose Models ---
const User = mongoose.model('User', UserSchema);
const Property = mongoose.model('Property', PropertySchema);
const Review = mongoose.model('Review', ReviewSchema);
const Favorite = mongoose.model('Favorite', FavoriteSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);
const Message = mongoose.model('Message', MessageSchema);
const PropertyView = mongoose.model('PropertyView', PropertyViewSchema);

// --- Middleware & Config ---
const options = { auth: { api_key: process.env.SENDGRID_API_KEY } };
const transporter = nodemailer.createTransport(sgTransport(options));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

const sendEmail = async (to, subject, html) => {
    try {
        await transporter.sendMail({
            from: process.env.SENDGRID_FROM_EMAIL,
            to: to,
            subject: subject,
            html: html,
        });
        console.log(`Email sent to ${to}`);
    } catch (error) {
        console.error(`Error sending email to ${to}:`, error);
    }
};

// --- START OF UPDATED WEBSOCKET CODE ---
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'auth' && data.token) {
        jwt.verify(data.token, JWT_SECRET, (err, user) => {
          if (!err) {
            ws.userId = user.userId;
            ws.userType = user.userType; // Store userType for chatbot logic
            ws.conversationId = data.conversationId;
          } else {
            ws.close();
          }
        });
      }
      else if (data.type === 'message' && ws.userId) {
        const { conversation_id, content } = data.payload;

        // Save the original user's message
        const newMessage = new Message({ conversation_id, sender_id: ws.userId, content });
        await newMessage.save();

        // Broadcast the original message to other clients in the conversation
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === ws.OPEN && client.conversationId === conversation_id) {
            client.send(JSON.stringify({ type: 'newMessage', payload: newMessage }));
          }
        });

        // --- Chatbot Logic ---
        // If the message is from a student, check for keywords and send an automated reply.
        if (ws.userType === 'student') {
          const conversation = await Conversation.findById(conversation_id);
          if (!conversation) return;

          const landlordId = conversation.landlord_id;
          let botReply = null;

          const lowerCaseContent = content.toLowerCase();

          if (lowerCaseContent.includes('available') || lowerCaseContent.includes('still have this')) {
            botReply = "Hello! Yes, this property is still available. Feel free to ask any other questions you may have.";
          } else if (lowerCaseContent.includes('contact') || lowerCaseContent.includes('phone') || lowerCaseContent.includes('number')) {
            botReply = "You can reach the landlord by replying to this message. For urgent matters, their contact number is 555-123-4567.";
          } else if (lowerCaseContent.includes('help') || lowerCaseContent.includes('support')) {
            botReply = "This is an automated message. The landlord will get back to you shortly. If you have questions about availability or contact info, please ask directly.";
          }

          if (botReply) {
            // Simulate a "typing" delay for the bot
            setTimeout(async () => {
              const botMessage = new Message({
                conversation_id,
                sender_id: landlordId, // Send the message as if it's from the landlord
                content: botReply,
              });
              await botMessage.save();

              // Broadcast the bot's reply to everyone in the conversation
              wss.clients.forEach(client => {
                if (client.readyState === ws.OPEN && client.conversationId === conversation_id) {
                  client.send(JSON.stringify({ type: 'newMessage', payload: botMessage }));
                }
              });
            }, 1500); // 1.5-second delay
          }
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });
});
// --- END OF UPDATED WEBSOCKET CODE ---


// --- REST API Routes ---
app.post('/api/signup', async (req, res) => {
    const { email, password, userType } = req.body;
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(409).json({ message: 'Email already registered.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[email] = { hashedPassword, userType, otp, timestamp: Date.now() };
        const subject = "Your Housing Hub Verification Code";
        const html = `<h1>Housing Hub Email Verification</h1><p>Your OTP is: <strong>${otp}</strong></p><p>This code expires in 10 minutes.</p>`;
        // await sendEmail(email, subject, html);
        console.log('Generated OTP for', email, ':', otp); // Keep this for local testing
        setTimeout(() => { if (otpStore[email]?.otp === otp) delete otpStore[email]; }, 600000);
        res.status(200).json({ message: 'OTP sent to your email.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error during signup.' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const storedData = otpStore[email];
    if (!storedData || storedData.otp !== otp) {
        return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }
    try {
        const { hashedPassword, userType } = storedData;
        const newUser = new User({ email, password: hashedPassword, user_type: userType });
        await newUser.save();
        delete otpStore[email];
        const token = jwt.sign({ userId: newUser._id, email: newUser.email, userType: newUser.user_type }, JWT_SECRET, { expiresIn: "1h" });
        res.status(201).json({ message: 'User registered!', token, email: newUser.email, userId: newUser._id, userType: newUser.user_type });
    } catch (error) {
        res.status(500).json({ message: 'Server error during user creation.' });
    }
});

app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: "Invalid email or password." });
        }
        const token = jwt.sign({ userId: user._id, email: user.email, userType: user.user_type }, JWT_SECRET, { expiresIn: "1h" });
        res.json({ message: "Login successful", token, email: user.email, userId: user._id, userType: user.user_type });
    } catch (err) {
        res.status(500).json({ message: "Server error." });
    }
});

app.get('/api/properties', async (req, res) => {
    try {
        const properties = await Property.find({}).sort({ createdAt: -1 });
        res.json(properties);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching properties.' });
    }
});

app.get('/api/properties/:id', async (req, res) => {
    try {
        const property = await Property.findById(req.params.id);
        if (!property) return res.status(404).json({ message: 'Property not found.' });
        res.json(property);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching property.' });
    }
});

app.post('/api/properties', authenticateToken, upload.array('images', 5), async (req, res) => {
    try {
        let imageUrls = [];
        if (req.files) {
            for(const file of req.files) {
                const result = await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`, { folder: 'housing_hub_properties' });
                imageUrls.push(result.secure_url);
            }
        }
        const newProperty = new Property({ 
            ...req.body, 
            image_url: imageUrls[0] || '',
            images: imageUrls,
            landlord_id: req.user.userId 
        });
        await newProperty.save();
        res.status(201).json({ message: 'Property added successfully!', propertyId: newProperty._id });
    } catch (error) {
        console.error("Error adding property:", error)
        res.status(500).json({ message: 'Server error adding property.' });
    }
});

app.put('/api/properties/:id', authenticateToken, upload.array('images', 5), async (req, res) => {
    const { id } = req.params;
    try {
        const property = await Property.findById(id);
        if (!property || property.landlord_id.toString() !== req.user.userId) {
            return res.status(403).json({ message: 'Unauthorized.' });
        }
        const updatedData = { ...req.body };
        if (req.files && req.files.length > 0) {
            let imageUrls = [];
            for(const file of req.files) {
                const result = await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`, { folder: 'housing_hub_properties' });
                imageUrls.push(result.secure_url);
            }
            updatedData.images = imageUrls;
            updatedData.image_url = imageUrls[0] || '';
        }
        await Property.findByIdAndUpdate(id, updatedData, { new: true });
        res.json({ message: 'Property updated successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error updating property.' });
    }
});

app.delete('/api/properties/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const property = await Property.findById(id);
        if (!property || property.landlord_id.toString() !== req.user.userId) {
            return res.status(403).json({ message: 'Unauthorized.' });
        }
        await Property.findByIdAndDelete(id);
        await Review.deleteMany({ property_id: id });
        await Favorite.deleteMany({ property_id: id });
        res.json({ message: 'Property deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error deleting property.' });
    }
});

app.get('/api/conversations', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const conversations = await Conversation.find({ $or: [{ student_id: userId }, { landlord_id: userId }] })
            .populate('property_id', 'title').populate('student_id', 'email').populate('landlord_id', 'email')
            .sort({ createdAt: -1 });
        res.json(conversations);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching conversations.' });
    }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
    const { property_id, landlord_id } = req.body;
    try {
        let convo = await Conversation.findOne({ property_id, student_id: req.user.userId });
        if (convo) return res.json({ conversationId: convo._id });
        const newConvo = new Conversation({ property_id, student_id: req.user.userId, landlord_id });
        await newConvo.save();
        res.status(201).json({ conversationId: newConvo._id });
    } catch (error) {
        res.status(500).json({ message: 'Server error starting conversation.' });
    }
});

app.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;
    try {
        const convo = await Conversation.findOne({ _id: id, $or: [{ student_id: userId }, { landlord_id: userId }] });
        if (!convo) return res.status(403).json({ message: 'Unauthorized.' });
        const messages = await Message.find({ conversation_id: id }).sort({ createdAt: 'asc' });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching messages.' });
    }
});

app.get('/api/favorites', authenticateToken, async (req, res) => {
    try {
        const favorites = await Favorite.find({ user_id: req.user.userId }).populate('property_id');
        res.json(favorites.map(fav => fav.property_id));
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching favorites.' });
    }
});

app.post('/api/favorites', authenticateToken, async (req, res) => {
    const { property_id } = req.body;
    try {
        await Favorite.create({ user_id: req.user.userId, property_id });
        res.status(201).json({ message: 'Property added to favorites.' });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: 'Already in favorites.' });
        res.status(500).json({ message: 'Server error adding favorite.' });
    }
});

app.delete('/api/favorites/:propertyId', authenticateToken, async (req, res) => {
    const { propertyId } = req.params;
    try {
        await Favorite.deleteOne({ user_id: req.user.userId, property_id: propertyId });
        res.status(200).json({ message: 'Property removed from favorites.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error removing favorite.' });
    }
});

app.get('/api/properties/:propertyId/reviews', async (req, res) => {
    try {
        const reviews = await Review.find({ property_id: req.params.propertyId }).populate('user_id', 'email').sort({ createdAt: 'desc' });
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching reviews.' });
    }
});

app.post('/api/reviews', authenticateToken, async (req, res) => {
    if (req.user.userType !== 'student') return res.status(403).json({ message: 'Only students can leave reviews.' });
    try {
        const newReview = new Review({ ...req.body, user_id: req.user.userId });
        await newReview.save();
        res.status(201).json(newReview);
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: 'You have already reviewed this property.' });
        res.status(500).json({ message: 'Server error posting review.' });
    }
});

app.post('/api/properties/:propertyId/view', async (req, res) => {
    try {
        await PropertyView.create({ property_id: req.params.propertyId });
        res.status(200).json({ message: 'View recorded.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error recording view.' });
    }
});

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    if (req.user.userType !== 'landlord') return res.status(403).json({ message: 'Access denied.' });
    try {
        const landlordId = req.user.userId;
        const properties = await Property.find({ landlord_id: landlordId }).select('_id title image_url');
        const propertyIds = properties.map(p => p._id);

        const summary = {
            totalProperties: properties.length,
            totalViews: await PropertyView.countDocuments({ property_id: { $in: propertyIds } }),
            totalFavorites: await Favorite.countDocuments({ property_id: { $in: propertyIds } }),
            totalConversations: await Conversation.countDocuments({ landlord_id: landlordId })
        };

        const propertyStats = await Promise.all(properties.map(async (prop) => ({
            _id: prop._id,
            title: prop.title,
            image_url: prop.image_url,
            view_count: await PropertyView.countDocuments({ property_id: prop._id }),
            favorite_count: await Favorite.countDocuments({ property_id: prop._id }),
            conversation_count: await Conversation.countDocuments({ property_id: prop._id })
        })));

        res.json({ summary, properties: propertyStats });
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching dashboard stats.' });
    }
});

server.listen(PORT, () => {
  console.log(`Backend server with WebSocket running on http://localhost:${PORT}`);
});
