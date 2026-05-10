const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();

// ============ CORS ============
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// ============ SERVE STATIC HTML FILES ============
// This is the CRITICAL FIX - serve HTML files from the current directory
app.use(express.static(__dirname));

// Handle article routes - serve article.html
app.get('/article/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, 'article.html'));
});

// Handle other page routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/products', (req, res) => {
    res.sendFile(path.join(__dirname, 'products.html'));
});

app.get('/ebook', (req, res) => {
    res.sendFile(path.join(__dirname, 'ebook.html'));
});

app.get('/subscription', (req, res) => {
    res.sendFile(path.join(__dirname, 'subscription.html'));
});

app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

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

const JWT_SECRET = process.env.JWT_SECRET || 'beauty-bloom-secret';

// ============ VERIFY ADMIN ============
const verifyAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ HEALTH ============
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', firebase: isFirebaseInitialized });
});

// ============ ARTICLES API ============
app.get('/api/articles', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.json([]);
        }
        const snapshot = await db.collection('articles').orderBy('createdAt', 'desc').get();
        const articles = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            articles.push({
                id: doc.id,
                title: data.title || '',
                slug: data.slug || '',
                imageUrl: data.imageUrl || '',
                shortDesc: data.shortDesc || '',
                category: data.category || 'all',
                createdAt: data.createdAt || new Date().toISOString()
            });
        });
        res.json(articles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SINGLE ARTICLE API ============
app.get('/api/article/:slug', async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase();
        
        if (!isFirebaseInitialized) {
            return res.status(404).json({ error: 'Article not found' });
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
        
        // Ensure fullContent exists
        if (!article.fullContent) {
            article.fullContent = article.content || 'Content for this article is being prepared. Please check back soon!';
        }
        
        res.json(article);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PRODUCTS API ============
app.get('/api/products', async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            return res.json([]);
        }
        const snapshot = await db.collection('affiliateLinks').orderBy('createdAt', 'desc').get();
        const products = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            products.push({
                id: doc.id,
                name: data.name || '',
                imageUrl: data.imageUrl || '',
                price: data.price || '',
                description: data.description || '',
                redirectUrl: data.redirectUrl || ''
            });
        });
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SUBSCRIPTION API ============
app.post('/api/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !isFirebaseInitialized) {
            return res.json({ isActive: false });
        }
        const snapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        let isActive = false;
        snapshot.forEach(doc => { isActive = doc.data().isActive === true; });
        res.json({ isActive });
    } catch (error) {
        res.json({ isActive: false });
    }
});

app.post('/api/ebooks', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !isFirebaseInitialized) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        const subSnapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        if (subSnapshot.empty) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        let isActive = false;
        subSnapshot.forEach(doc => { isActive = doc.data().isActive === true; });
        
        if (!isActive) {
            return res.status(403).json({ error: 'Active subscription required' });
        }
        
        const ebookSnapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        ebookSnapshot.forEach(doc => {
            const data = doc.data();
            ebooks.push({
                id: doc.id,
                name: data.name || '',
                imageUrl: data.imageUrl || '',
                pdfUrl: data.pdfUrl || ''
            });
        });
        res.json(ebooks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !isFirebaseInitialized) {
            return res.json({ message: 'Email registered' });
        }
        const existing = await db.collection('subscribers').where('email', '==', email).get();
        if (!existing.empty) return res.json({ message: 'Email already registered' });
        await db.collection('subscribers').add({ email, isActive: false, subscribedAt: new Date().toISOString() });
        res.json({ success: true, message: 'Subscribed!' });
    } catch (error) {
        res.json({ success: true, message: 'Subscribed!' });
    }
});

// ============ USER AUTH ============
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
        if (!isFirebaseInitialized) return res.status(503).json({ error: 'Service unavailable' });
        
        const usersRef = db.collection('users');
        const existing = await usersRef.where('email', '==', email).limit(1).get();
        if (!existing.empty) return res.status(400).json({ error: 'User already exists' });
        
        const userRecord = await auth.createUser({ email, password, displayName: name });
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.collection('users').doc(userRecord.uid).set({
            name, email, password: hashedPassword,
            createdAt: new Date().toISOString(),
            uid: userRecord.uid
        });
        
        await db.collection('subscribers').add({ email, name, isActive: false, subscribedAt: new Date().toISOString() });
        
        res.json({ success: true, message: 'Account created!' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!isFirebaseInitialized) return res.status(503).json({ error: 'Service unavailable' });
        
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).limit(1).get();
        if (snapshot.empty) return res.status(401).json({ error: 'Invalid credentials' });
        
        let user = null, userId = null;
        snapshot.forEach(doc => { user = doc.data(); userId = doc.id; });
        
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ email: user.email, name: user.name, uid: userId }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, email: user.email, name: user.name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN API ============
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, email });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/verify', verifyAdmin, (req, res) => { res.json({ valid: true }); });
app.get('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    const snapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
    const ebooks = []; snapshot.forEach(doc => ebooks.push({ id: doc.id, ...doc.data() }));
    res.json(ebooks);
});
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
    const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
    const article = {
        title, slug: slug.toLowerCase().trim(), imageUrl, shortDesc, fullContent,
        category: category || 'all', createdAt: new Date().toISOString()
    };
    const docRef = await db.collection('articles').add(article);
    res.json({ id: docRef.id, ...article });
});
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
    const updateData = { title, imageUrl, shortDesc, fullContent, category: category || 'all', updatedAt: new Date().toISOString() };
    if (slug) updateData.slug = slug.toLowerCase().trim();
    await db.collection('articles').doc(req.params.id).update(updateData);
    res.json({ success: true });
});
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    await db.collection('articles').doc(req.params.id).delete();
    res.json({ success: true });
});
app.post('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    const { name, imageUrl, pdfUrl } = req.body;
    const ebook = { name, imageUrl, pdfUrl, createdAt: new Date().toISOString() };
    const docRef = await db.collection('ebooks').add(ebook);
    res.json({ id: docRef.id, ...ebook });
});
app.delete('/api/admin/ebooks/:id', verifyAdmin, async (req, res) => {
    await db.collection('ebooks').doc(req.params.id).delete();
    res.json({ success: true });
});
app.post('/api/admin/products', verifyAdmin, async (req, res) => {
    const { name, imageUrl, price, description, redirectUrl } = req.body;
    const product = { name, imageUrl, price, description, redirectUrl, createdAt: new Date().toISOString() };
    const docRef = await db.collection('affiliateLinks').add(product);
    res.json({ id: docRef.id, ...product });
});
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
    await db.collection('affiliateLinks').doc(req.params.id).delete();
    res.json({ success: true });
});
app.get('/api/admin/subscribers', verifyAdmin, async (req, res) => {
    const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
    const subscribers = []; snapshot.forEach(doc => subscribers.push({ id: doc.id, ...doc.data() }));
    res.json(subscribers);
});
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    await db.collection('subscribers').doc(req.params.id).update({
        isActive: req.body.isActive === true,
        updatedAt: new Date().toISOString()
    });
    res.json({ success: true });
});
app.delete('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    await db.collection('subscribers').doc(req.params.id).delete();
    res.json({ success: true });
});

// ============ 404 FOR API ============
app.all('/api/*', (req, res) => { res.status(404).json({ error: 'API endpoint not found' }); });

// ============ START ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
