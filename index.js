const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ============ CORS CONFIGURATION ============
const allowedOrigins = [
    'https://thebeautybloom.lovestoblog.com',
    'https://beauty-bloom-azure.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('⚠️ Blocked origin:', origin);
            callback(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.options('*', cors());
app.use(express.json());

// ============ FIREBASE INITIALIZATION ============
let db = null;
let auth = null;
let isFirebaseInitialized = false;

const hasFirebaseCreds = process.env.FIREBASE_PROJECT_ID && 
                         process.env.FIREBASE_PRIVATE_KEY && 
                         process.env.FIREBASE_CLIENT_EMAIL;

if (!hasFirebaseCreds) {
    console.error('❌ Missing Firebase credentials');
} else {
    try {
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        };
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        
        db = admin.firestore();
        auth = admin.auth();
        isFirebaseInitialized = true;
        console.log('✅ Firebase initialized');
    } catch (error) {
        console.error('❌ Firebase error:', error.message);
    }
}

const JWT_SECRET = process.env.JWT_SECRET || 'beauty-bloom-secret-key-2026';

// ============ VERIFY ADMIN MIDDLEWARE ============
const verifyAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        firebase: isFirebaseInitialized
    });
});

// ============ USER SIGNUP ============
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const usersRef = db.collection('users');
        const existing = await usersRef.where('email', '==', email).limit(1).get();
        
        if (!existing.empty) {
            return res.status(400).json({ error: 'User already exists' });
        }
        
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            displayName: name
        });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.collection('users').doc(userRecord.uid).set({
            name: name,
            email: email,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            uid: userRecord.uid
        });
        
        await db.collection('subscribers').add({
            email: email,
            name: name,
            isActive: false,
            subscribedAt: new Date().toISOString()
        });
        
        res.json({ success: true, message: 'Account created successfully!' });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

// ============ USER LOGIN ============
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        let user = null;
        let userId = null;
        snapshot.forEach(doc => {
            user = doc.data();
            userId = doc.id;
        });
        
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const token = jwt.sign(
            { email: user.email, name: user.name, uid: userId },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({ success: true, token, email: user.email, name: user.name });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ GET ALL ARTICLES ============
app.get('/api/articles', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const snapshot = await db.collection('articles').orderBy('createdAt', 'desc').get();
        const articles = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            articles.push({
                id: doc.id,
                title: data.title,
                slug: data.slug,
                imageUrl: data.imageUrl,
                shortDesc: data.shortDesc,
                category: data.category || 'all',
                createdAt: data.createdAt
            });
        });
        
        res.json(articles);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ GET SINGLE ARTICLE (CASE-INSENSITIVE) ============
app.get('/api/article/:slug', async (req, res) => {
    try {
        let slug = req.params.slug.toLowerCase().trim();
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const snapshot = await db.collection('articles').get();
        let article = null;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.slug && data.slug.toLowerCase() === slug) {
                article = { id: doc.id, ...data };
            }
        });
        
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }
        
        res.json(article);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ GET ALL PRODUCTS ============
app.get('/api/products', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const snapshot = await db.collection('affiliateLinks').orderBy('createdAt', 'desc').get();
        const products = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            products.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                price: data.price,
                description: data.description,
                redirectUrl: data.redirectUrl
            });
        });
        
        res.json(products);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ CHECK SUBSCRIPTION ============
app.post('/api/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const snapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.json({ isActive: false });
        }
        
        let isActive = false;
        snapshot.forEach(doc => {
            isActive = doc.data().isActive === true;
        });
        
        res.json({ isActive: isActive });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ GET EBOOKS (REQUIRES SUBSCRIPTION) ============
app.post('/api/ebooks', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const subSnapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        
        if (subSnapshot.empty) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        let isActive = false;
        subSnapshot.forEach(doc => {
            isActive = doc.data().isActive === true;
        });
        
        if (!isActive) {
            return res.status(403).json({ error: 'Active subscription required' });
        }
        
        const ebookSnapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        
        ebookSnapshot.forEach(doc => {
            const data = doc.data();
            ebooks.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                pdfUrl: data.pdfUrl
            });
        });
        
        res.json(ebooks);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ NEWSLETTER SUBSCRIBE ============
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            return res.status(503).json({ error: 'Service unavailable' });
        }
        
        const existing = await db.collection('subscribers').where('email', '==', email).get();
        
        if (!existing.empty) {
            return res.json({ message: 'Email already registered' });
        }
        
        await db.collection('subscribers').add({
            email: email,
            isActive: false,
            subscribedAt: new Date().toISOString()
        });
        
        res.json({ success: true, message: 'Subscribed successfully!' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN LOGIN ============
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (email !== process.env.ADMIN_EMAIL) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({ success: true, token, email });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN VERIFY ============
app.get('/api/admin/verify', verifyAdmin, (req, res) => {
    res.json({ valid: true, email: req.admin.email });
});

// ============ ADMIN: GET ALL EBOOKS ============
app.get('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        snapshot.forEach(doc => {
            ebooks.push({ id: doc.id, ...doc.data() });
        });
        res.json(ebooks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: ADD ARTICLE ============
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
    try {
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        if (!title || !slug || !imageUrl || !shortDesc || !fullContent) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        const normalizedSlug = slug.toLowerCase().trim();
        
        const article = {
            title,
            slug: normalizedSlug,
            imageUrl,
            shortDesc,
            fullContent,
            category: category || 'all',
            createdAt: new Date().toISOString()
        };
        
        const docRef = await db.collection('articles').add(article);
        res.json({ id: docRef.id, ...article });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: UPDATE ARTICLE ============
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        const updateData = {
            title,
            imageUrl,
            shortDesc,
            fullContent,
            category: category || 'all',
            updatedAt: new Date().toISOString()
        };
        
        if (slug) {
            updateData.slug = slug.toLowerCase().trim();
        }
        
        await db.collection('articles').doc(id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: DELETE ARTICLE ============
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        await db.collection('articles').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: ADD EBOOK ============
app.post('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        const { name, imageUrl, pdfUrl } = req.body;
        
        const ebook = {
            name,
            imageUrl,
            pdfUrl,
            createdAt: new Date().toISOString()
        };
        
        const docRef = await db.collection('ebooks').add(ebook);
        res.json({ id: docRef.id, ...ebook });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: DELETE EBOOK ============
app.delete('/api/admin/ebooks/:id', verifyAdmin, async (req, res) => {
    try {
        await db.collection('ebooks').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: ADD PRODUCT ============
app.post('/api/admin/products', verifyAdmin, async (req, res) => {
    try {
        const { name, imageUrl, price, description, redirectUrl } = req.body;
        
        const product = {
            name,
            imageUrl,
            price,
            description,
            redirectUrl,
            createdAt: new Date().toISOString()
        };
        
        const docRef = await db.collection('affiliateLinks').add(product);
        res.json({ id: docRef.id, ...product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: DELETE PRODUCT ============
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
    try {
        await db.collection('affiliateLinks').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: GET ALL SUBSCRIBERS ============
app.get('/api/admin/subscribers', verifyAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
        const subscribers = [];
        snapshot.forEach(doc => {
            subscribers.push({ id: doc.id, ...doc.data() });
        });
        res.json(subscribers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: UPDATE SUBSCRIBER STATUS ============
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { isActive } = req.body;
        await db.collection('subscribers').doc(req.params.id).update({
            isActive: isActive === true,
            updatedAt: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN: DELETE SUBSCRIBER ============
app.delete('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        await db.collection('subscribers').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ 404 HANDLER ============
app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌸 Beauty Bloom Server running on port ${PORT}`);
    console.log(`✅ Firebase: ${isFirebaseInitialized ? 'Connected' : 'FAILED'}`);
});
