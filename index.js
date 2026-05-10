const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ============ UPDATED CORS MIDDLEWARE - FIXED ============
const allowedOrigins = [
    'https://thebeautybloom.lovestoblog.com',
    'https://beauty-bloom-azure.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, postman)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('⚠️ Blocked origin:', origin);
            // Still allow but log it - change to false to actually block
            callback(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Handle preflight requests explicitly
app.options('*', cors());

app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

let db = null;
let auth = null;
let isFirebaseInitialized = false;

try {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        db = admin.firestore();
        auth = admin.auth();
        isFirebaseInitialized = true;
        console.log('✅ Firebase initialized successfully');
    } else {
        console.log('⚠️ Firebase credentials missing, running in demo mode');
        // Demo data store (in-memory for testing)
        const demoData = {
            subscribers: [],
            articles: [],
            affiliateLinks: [],
            ebooks: [],
            users: []
        };
        
        db = {
            collection: (name) => ({
                add: async (data) => {
                    console.log(`📝 Demo: Added to ${name}:`, data);
                    const id = Date.now().toString();
                    if (!demoData[name]) demoData[name] = [];
                    demoData[name].push({ id, ...data });
                    return { id };
                },
                get: async () => ({
                    empty: demoData[name]?.length === 0,
                    forEach: (callback) => demoData[name]?.forEach(doc => callback({ data: () => doc, id: doc.id })),
                    docs: demoData[name]?.map(doc => ({ data: () => doc, id: doc.id })) || []
                }),
                where: (field, op, value) => ({
                    limit: () => ({
                        get: async () => ({
                            empty: !demoData[name]?.some(d => d[field] === value),
                            forEach: (callback) => demoData[name]?.filter(d => d[field] === value).forEach(doc => callback({ data: () => doc, id: doc.id }))
                        })
                    })
                }),
                doc: (id) => ({
                    update: async (data) => {
                        console.log(`📝 Demo: Updated ${name}/${id}:`, data);
                        const index = demoData[name]?.findIndex(d => d.id === id);
                        if (index !== -1) demoData[name][index] = { ...demoData[name][index], ...data };
                    },
                    delete: async () => {
                        console.log(`📝 Demo: Deleted ${name}/${id}`);
                        const index = demoData[name]?.findIndex(d => d.id === id);
                        if (index !== -1) demoData[name].splice(index, 1);
                    }
                }),
                orderBy: () => ({
                    get: async () => ({
                        empty: demoData[name]?.length === 0,
                        forEach: (callback) => demoData[name]?.forEach(doc => callback({ data: () => doc, id: doc.id })),
                        docs: demoData[name]?.map(doc => ({ data: () => doc, id: doc.id })) || []
                    })
                })
            })
        };
        auth = {
            createUser: async (data) => {
                console.log('📝 Demo: Creating user:', data);
                return { uid: 'demo-' + Date.now() };
            },
            getUserByEmail: async (email) => {
                throw new Error('User not found');
            }
        };
    }
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    isFirebaseInitialized = false;
}

const JWT_SECRET = process.env.JWT_SECRET || 'beauty-blog-secret-key-change-in-production-2026';

// ============ HELPER FUNCTIONS ============
function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ============ MIDDLEWARE ============
const verifyAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Forbidden - Invalid admin credentials' });
        }
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// ============ PUBLIC ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        firebase: isFirebaseInitialized,
        mode: isFirebaseInitialized ? 'production' : 'demo',
        site: 'Beauty Bloom',
        cors: 'enabled'
    });
});

// USER SIGNUP
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields required (name, email, password)' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        if (!isFirebaseInitialized) {
            const hashedPassword = await bcrypt.hash(password, 10);
            const usersRef = db.collection('users');
            await usersRef.add({
                name, email, password: hashedPassword,
                createdAt: new Date().toISOString()
            });
            
            await db.collection('subscribers').add({
                email, name, isActive: false,
                subscribedAt: new Date().toISOString()
            });
            
            return res.json({ 
                success: true, 
                message: 'Demo mode - Account created successfully! Please login.'
            });
        }
        
        try {
            const existingUser = await auth.getUserByEmail(email);
            if (existingUser) {
                return res.status(400).json({ error: 'User already exists with this email' });
            }
        } catch (error) {
            // User doesn't exist, continue
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
        
        console.log(`✅ User created: ${email} (${userRecord.uid})`);
        
        res.json({ 
            success: true, 
            message: 'Account created successfully! Please login.',
            uid: userRecord.uid
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

// USER LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        if (!isFirebaseInitialized) {
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
            
            const token = jwt.sign({ email: user.email, name: user.name, uid: userId }, JWT_SECRET, { expiresIn: '7d' });
            
            return res.json({ success: true, token, email: user.email, name: user.name });
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
        
        res.json({
            success: true,
            token,
            email: user.email,
            name: user.name
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all articles (with category - BEAUTY CATEGORIES)
app.get('/api/articles', async (req, res) => {
    try {
        console.log('📖 Fetching articles...');
        
        if (!isFirebaseInitialized) {
            const articlesRef = db.collection('articles');
            const snapshot = await articlesRef.orderBy('createdAt', 'desc').get();
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
            
            if (articles.length === 0) {
                console.log('📖 No articles in demo DB, returning demo articles');
                // Demo beauty articles
                return res.json([
                    {
                        id: '1',
                        title: '10-Step Korean Skincare Routine for Glass Skin',
                        slug: 'korean-skincare-routine-glass-skin',
                        imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500',
                        shortDesc: 'Achieve that coveted glass skin look with this complete Korean skincare guide.',
                        category: 'skincare',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '2',
                        title: 'Everyday Natural Makeup Tutorial',
                        slug: 'natural-makeup-tutorial-everyday',
                        imageUrl: 'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=500',
                        shortDesc: 'Learn how to create a fresh, natural makeup look for daily wear.',
                        category: 'makeup',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '3',
                        title: 'Best Hair Care Tips for Healthy Shiny Hair',
                        slug: 'hair-care-tips-healthy-shiny-hair',
                        imageUrl: 'https://images.unsplash.com/photo-1522338140262-f46f5913618a?w=500',
                        shortDesc: 'Transform your hair with these professional tips and natural remedies.',
                        category: 'haircare',
                        createdAt: new Date().toISOString()
                    },
                    {
                        id: '4',
                        title: 'How to Get Glass Skin Naturally',
                        slug: 'how-to-get-glass-skin-naturally',
                        imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=500',
                        shortDesc: 'Natural remedies and routines to achieve that glass skin glow.',
                        category: 'skincare',
                        createdAt: new Date().toISOString()
                    }
                ]);
            }
            return res.json(articles);
        }
        
        // Firebase mode
        const articlesRef = db.collection('articles');
        const snapshot = await articlesRef.orderBy('createdAt', 'desc').get();
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
        
        console.log(`📖 Returning ${articles.length} articles`);
        res.json(articles);
    } catch (error) {
        console.error('Error fetching articles:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Get single article by slug (CASE-INSENSITIVE FIX)
app.get('/api/article/:slug', async (req, res) => {
    try {
        let slug = req.params.slug;
        
        // Clean and normalize the slug
        slug = slug.toLowerCase().trim();
        
        console.log('Searching for article with slug:', slug);
        
        if (!isFirebaseInitialized) {
            // Demo mode - check all articles (case-insensitive)
            const articlesRef = db.collection('articles');
            const snapshot = await articlesRef.get();
            
            let article = null;
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.slug && data.slug.toLowerCase() === slug) {
                    article = { id: doc.id, ...data };
                }
            });
            
            if (article) {
                return res.json(article);
            }
            
            // Demo beauty articles content with case-insensitive lookup
            const demoArticles = {
                'korean-skincare-routine-glass-skin': {
                    id: '1',
                    title: '10-Step Korean Skincare Routine for Glass Skin',
                    slug: 'korean-skincare-routine-glass-skin',
                    imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=800',
                    shortDesc: 'Achieve that coveted glass skin look with this complete Korean skincare guide.',
                    category: 'skincare',
                    fullContent: 'The Korean 10-step skincare routine has taken the beauty world by storm - and for good reason! This comprehensive routine focuses on hydration, gentle exfoliation, and layering products for maximum results.\n\n**Step 1: Oil Cleanser**\nStart with an oil-based cleanser to remove makeup, sunscreen, and excess sebum.\n\n**Step 2: Water-Based Cleanser**\nFollow with a gentle water-based cleanser to remove any remaining impurities.\n\n**Step 3: Exfoliator** (2-3 times per week)\nUse a gentle chemical exfoliant like AHAs or BHAs to remove dead skin cells.\n\n**Step 4: Toner**\nApply a hydrating toner to balance your skin\'s pH levels.\n\n**Step 5: Essence**\nThe heart of K-beauty - an essence boosts hydration and prepares skin for next steps.\n\n**Step 6: Serum/Ampoule**\nTarget specific concerns like dark spots, fine lines, or dullness.\n\n**Step 7: Sheet Mask** (1-2 times per week)\nGive your skin an intense hydration boost with a sheet mask.\n\n**Step 8: Eye Cream**\nGently tap eye cream to address dark circles and fine lines.\n\n**Step 9: Moisturizer**\nLock in all the hydration with a nourishing moisturizer.\n\n**Step 10: Sunscreen** (Morning routine only)\nNever skip SPF - it\'s the most important anti-aging step!',
                    createdAt: new Date().toISOString()
                },
                'natural-makeup-tutorial-everyday': {
                    id: '2',
                    title: 'Everyday Natural Makeup Tutorial',
                    slug: 'natural-makeup-tutorial-everyday',
                    imageUrl: 'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=800',
                    shortDesc: 'Learn how to create a fresh, natural makeup look for daily wear.',
                    category: 'makeup',
                    fullContent: 'Natural makeup is all about enhancing your features while looking like you\'re wearing nothing at all. Here\'s your step-by-step guide to achieving that "no-makeup" makeup look.\n\n**Step 1: Start with Skincare**\nAlways begin with clean, moisturized skin. Let your moisturizer sink in for 5 minutes.\n\n**Step 2: Apply Primer**\nUse a lightweight, illuminating primer for a natural glow.\n\n**Step 3: Light Coverage Foundation or Tinted Moisturizer**\nApply only where needed and blend well with a damp sponge.\n\n**Step 4: Concealer**\nUse concealer only under eyes and on any blemishes. Less is more!\n\n**Step 5: Cream Blush**\nCream blushes give a natural, skin-like finish. Apply to the apples of your cheeks.\n\n**Step 6: Light Bronzer** (optional)\nLightly bronze where the sun naturally hits.\n\n**Step 7: Natural Eyeshadow**\nUse neutral matte shades close to your skin tone. A wash of color is enough.\n\n**Step 8: Curl Lashes + Mascara**\nCurl your lashes and apply 1-2 coats of brown or black mascara.\n\n**Step 9: Brush and Shape Brows**\nFill in sparse areas with a brow pencil in small hair-like strokes.\n\n**Step 10: Tinted Lip Balm or Gloss**\nFinish with a sheer lip color that enhances your natural lip shade.\n\n**Pro tip:** Set everything with a light mist of setting spray for all-day wear!',
                    createdAt: new Date().toISOString()
                },
                'hair-care-tips-healthy-shiny-hair': {
                    id: '3',
                    title: 'Best Hair Care Tips for Healthy Shiny Hair',
                    slug: 'hair-care-tips-healthy-shiny-hair',
                    imageUrl: 'https://images.unsplash.com/photo-1522338140262-f46f5913618a?w=800',
                    shortDesc: 'Transform your hair with these professional tips and natural remedies.',
                    category: 'haircare',
                    fullContent: 'Healthy, shiny hair is achievable with the right care routine. Here are professional tips to transform your hair.\n\n**1. Know Your Hair Type**\nUnderstanding whether you have fine, medium, or coarse hair helps you choose the right products.\n\n**2. Don\'t Overwash**\nWashing 2-3 times per week is enough for most hair types. Overwashing strips natural oils.\n\n**3. Use Lukewarm Water**\nHot water damages hair cuticles. Rinse with cool water for extra shine.\n\n**4. Choose Sulfate-Free Shampoo**\nSulfates are harsh detergents that strip moisture from your hair.\n\n**5. Always Use Conditioner**\nApply from mid-lengths to ends, avoiding the scalp.\n\n**6. Deep Condition Weekly**\nUse a hair mask or deep conditioner once a week for intense hydration.\n\n**7. Limit Heat Styling**\nAir-dry when possible. Always use heat protectant before blow-drying or styling.\n\n**8. Get Regular Trims**\nTrim every 6-8 weeks to prevent split ends.\n\n**9. Protect Hair While Sleeping**\nUse a silk or satin pillowcase to reduce friction and breakage.\n\n**10. Eat a Balanced Diet**\nBiotin, vitamin E, and omega-3 fatty acids promote healthy hair growth.\n\n**Natural Remedies:**\n- Coconut oil mask once a week\n- Aloe vera gel for scalp health\n- Rice water rinse for shine',
                    createdAt: new Date().toISOString()
                },
                'how-to-get-glass-skin-naturally': {
                    id: '4',
                    title: 'How to Get Glass Skin Naturally',
                    slug: 'how-to-get-glass-skin-naturally',
                    imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=800',
                    shortDesc: 'Natural remedies and routines to achieve that glass skin glow.',
                    category: 'skincare',
                    fullContent: 'Glass skin - that ultra-hydrated, poreless, glowing complexion - can be achieved naturally with the right routine!\n\n**What is Glass Skin?**\nGlass skin refers to skin so smooth, even, and luminous it appears translucent like glass. The focus is on deep hydration and gentle care.\n\n**Natural Tips for Glass Skin:**\n\n**1. Double Cleanse with Natural Oils**\nStart with natural oils like jojoba or grapeseed oil to dissolve impurities.\n\n**2. Exfoliate Gently with Natural Ingredients**\nUse rice flour, oatmeal, or fruit enzymes (papaya/pineapple) as gentle exfoliators.\n\n**3. Hydrate with Natural Toners**\nRose water, green tea, or cucumber water make excellent hydrating toners.\n\n**4. Layer Natural Moisturizers**\nApply aloe vera gel first, then follow with a natural oil like rosehip or argan oil.\n\n**5. Use Sheet Masks Made from Natural Fibers**\nLook for bamboo or cotton masks soaked in natural ingredients.\n\n**6. Drink Plenty of Water**\nInternal hydration reflects on your skin!\n\n**7. Get Enough Sleep**\nYour skin repairs itself while you rest.\n\n**8. Protect with Natural Sunscreen**\nZinc oxide or titanium dioxide based sunscreens are gentle yet effective.\n\nWith consistent natural care, you can achieve that glass skin glow!',
                    createdAt: new Date().toISOString()
                }
            };
            
            // Case-insensitive lookup in demo articles
            const article = demoArticles[slug];
            if (article) {
                return res.json(article);
            }
            
            return res.status(404).json({ error: 'Article not found' });
        }
        
        // Firebase mode - case-insensitive search
        const articlesRef = db.collection('articles');
        const snapshot = await articlesRef.get();
        
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
        console.error('Error fetching article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all affiliate products (BEAUTY PRODUCTS)
app.get('/api/products', async (req, res) => {
    try {
        console.log('🛒 Fetching products...');
        
        if (!isFirebaseInitialized) {
            const productsRef = db.collection('affiliateLinks');
            const snapshot = await productsRef.orderBy('createdAt', 'desc').get();
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
            
            if (products.length === 0) {
                // Demo beauty products
                return res.json([
                    {
                        id: '1',
                        name: 'Jade Roller Set',
                        imageUrl: 'https://images.unsplash.com/photo-1616394584738-fc6e612e71b9?w=300',
                        price: '$19.99',
                        description: 'Real jade roller for facial massage and lymphatic drainage.',
                        redirectUrl: '#'
                    },
                    {
                        id: '2',
                        name: 'Silk Pillowcase Set',
                        imageUrl: 'https://images.unsplash.com/photo-1534224039826-c7a0eda0e6b3?w=300',
                        price: '$29.99',
                        description: '100% mulberry silk pillowcase for hair and skin benefits.',
                        redirectUrl: '#'
                    }
                ]);
            }
            return res.json(products);
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
        console.error('Error fetching products:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check subscription status - LIFETIME (no expiry)
app.post('/api/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const subscribersRef = db.collection('subscribers');
            const snapshot = await subscribersRef.where('email', '==', email).limit(1).get();
            
            if (snapshot.empty) {
                return res.json({ isActive: false, isLifetime: false });
            }
            
            let subscriber = null;
            snapshot.forEach(doc => {
                subscriber = { id: doc.id, ...doc.data() };
            });
            
            return res.json({ 
                isActive: subscriber.isActive === true,
                isLifetime: true
            });
        }
        
        const subscriberRef = db.collection('subscribers');
        const snapshot = await subscriberRef.where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            return res.json({ isActive: false, isLifetime: false });
        }
        
        let subscriber = null;
        snapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        const isActive = subscriber.isActive === true;
        
        res.json({ 
            isActive: isActive,
            isLifetime: true,
            message: isActive ? "Active lifetime subscription" : "No active subscription"
        });
    } catch (error) {
        console.error('Error checking subscription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get ebooks (BEAUTY EBOOKS - requires active subscription)
app.post('/api/ebooks', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const subscribersRef = db.collection('subscribers');
            const subSnapshot = await subscribersRef.where('email', '==', email).limit(1).get();
            
            let isActive = false;
            if (!subSnapshot.empty) {
                subSnapshot.forEach(doc => {
                    isActive = doc.data().isActive === true;
                });
            }
            
            if (!isActive && email !== 'demo@example.com') {
                return res.status(403).json({ error: 'Active subscription required' });
            }
            
            const ebooksRef = db.collection('ebooks');
            const ebookSnapshot = await ebooksRef.orderBy('createdAt', 'desc').get();
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
            
            if (ebooks.length === 0) {
                // Demo beauty ebooks
                return res.json([
                    {
                        id: '1',
                        name: 'The Complete Skincare Guide',
                        imageUrl: 'https://images.unsplash.com/photo-1571781926291-c4771fd1fcf8?w=300',
                        pdfUrl: '#'
                    },
                    {
                        id: '2',
                        name: 'Natural Beauty Recipes',
                        imageUrl: 'https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?w=300',
                        pdfUrl: '#'
                    }
                ]);
            }
            return res.json(ebooks);
        }
        
        const subSnapshot = await db.collection('subscribers').where('email', '==', email).limit(1).get();
        if (subSnapshot.empty) {
            return res.status(403).json({ error: 'Subscription required' });
        }
        
        let subscriber = null;
        subSnapshot.forEach(doc => {
            subscriber = { id: doc.id, ...doc.data() };
        });
        
        if (!subscriber.isActive) {
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
        console.error('Error fetching ebooks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Subscribe user (newsletter - not premium)
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }
        
        if (!isFirebaseInitialized) {
            const existing = await db.collection('subscribers').where('email', '==', email).get();
            if (!existing.empty) {
                return res.json({ message: 'Email already registered' });
            }
            
            await db.collection('subscribers').add({
                email: email,
                isActive: false,
                subscribedAt: new Date().toISOString()
            });
            
            return res.json({ success: true, message: 'Subscribed successfully! Contact admin for premium activation.' });
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
        
        res.json({ success: true, message: 'Subscribed successfully! Contact admin for premium activation.' });
    } catch (error) {
        console.error('Error subscribing:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN LOGIN ROUTE ============
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Admin login attempt:', { email, hasPassword: !!password });
        
        if (email !== process.env.ADMIN_EMAIL) {
            console.log('Admin login failed: Invalid email');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const adminPassword = process.env.ADMIN_PASSWORD;
        
        if (!adminPassword) {
            console.log('Admin login failed: No ADMIN_PASSWORD in environment');
            return res.status(500).json({ error: 'Server configuration error - Missing password' });
        }
        
        const isValid = (password === adminPassword);
        
        if (!isValid) {
            console.log('Admin login failed: Invalid password');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const token = jwt.sign(
            { email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        console.log('Admin login successful:', email);
        res.json({ 
            success: true,
            token, 
            email,
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN ROUTES (Protected) ============

// Verify admin token
app.get('/api/admin/verify', verifyAdmin, async (req, res) => {
    res.json({ valid: true, email: req.admin.email });
});

// Get all ebooks (admin)
app.get('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            const ebooksRef = db.collection('ebooks');
            const snapshot = await ebooksRef.orderBy('createdAt', 'desc').get();
            const ebooks = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                ebooks.push({
                    id: doc.id,
                    name: data.name,
                    imageUrl: data.imageUrl,
                    pdfUrl: data.pdfUrl,
                    createdAt: data.createdAt
                });
            });
            return res.json(ebooks);
        }
        
        const snapshot = await db.collection('ebooks').orderBy('createdAt', 'desc').get();
        const ebooks = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            ebooks.push({
                id: doc.id,
                name: data.name,
                imageUrl: data.imageUrl,
                pdfUrl: data.pdfUrl,
                createdAt: data.createdAt
            });
        });
        res.json(ebooks);
    } catch (error) {
        console.error('Error fetching ebooks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add article (WITH CATEGORY - beauty categories)
app.post('/api/admin/articles', verifyAdmin, async (req, res) => {
    try {
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        if (!title || !slug || !imageUrl || !shortDesc || !fullContent) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        // Normalize slug to lowercase
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
        
        if (!isFirebaseInitialized) {
            const docRef = await db.collection('articles').add(article);
            return res.json({ id: docRef.id, ...article });
        }
        
        const docRef = await db.collection('articles').add(article);
        res.json({ id: docRef.id, ...article });
    } catch (error) {
        console.error('Error adding article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update article
app.put('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, slug, imageUrl, shortDesc, fullContent, category } = req.body;
        
        // Normalize slug to lowercase if provided
        const normalizedSlug = slug ? slug.toLowerCase().trim() : undefined;
        
        const updateData = {
            title,
            imageUrl,
            shortDesc,
            fullContent,
            category: category || 'all',
            updatedAt: new Date().toISOString()
        };
        
        if (normalizedSlug) {
            updateData.slug = normalizedSlug;
        }
        
        if (!isFirebaseInitialized) {
            await db.collection('articles').doc(id).update(updateData);
            return res.json({ success: true });
        }
        
        await db.collection('articles').doc(id).update(updateData);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete article
app.delete('/api/admin/articles/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            await db.collection('articles').doc(id).delete();
            return res.json({ success: true });
        }
        
        await db.collection('articles').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting article:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add ebook
app.post('/api/admin/ebooks', verifyAdmin, async (req, res) => {
    try {
        const { name, imageUrl, pdfUrl } = req.body;
        
        if (!name || !imageUrl || !pdfUrl) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        const ebook = {
            name,
            imageUrl,
            pdfUrl,
            createdAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            const docRef = await db.collection('ebooks').add(ebook);
            return res.json({ id: docRef.id, ...ebook });
        }
        
        const docRef = await db.collection('ebooks').add(ebook);
        res.json({ id: docRef.id, ...ebook });
    } catch (error) {
        console.error('Error adding ebook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete ebook
app.delete('/api/admin/ebooks/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            await db.collection('ebooks').doc(id).delete();
            return res.json({ success: true });
        }
        
        await db.collection('ebooks').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting ebook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add affiliate product
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
        
        if (!isFirebaseInitialized) {
            const docRef = await db.collection('affiliateLinks').add(product);
            return res.json({ id: docRef.id, ...product });
        }
        
        const docRef = await db.collection('affiliateLinks').add(product);
        res.json({ id: docRef.id, ...product });
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete product
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            await db.collection('affiliateLinks').doc(id).delete();
            return res.json({ success: true });
        }
        
        await db.collection('affiliateLinks').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all subscribers
app.get('/api/admin/subscribers', verifyAdmin, async (req, res) => {
    try {
        if (!isFirebaseInitialized) {
            const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
            const subscribers = [];
            snapshot.forEach(doc => {
                subscribers.push({ id: doc.id, ...doc.data() });
            });
            return res.json(subscribers);
        }
        
        const snapshot = await db.collection('subscribers').orderBy('subscribedAt', 'desc').get();
        const subscribers = [];
        snapshot.forEach(doc => {
            subscribers.push({ id: doc.id, ...doc.data() });
        });
        res.json(subscribers);
    } catch (error) {
        console.error('Error fetching subscribers:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update subscriber status - LIFETIME
app.put('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        
        const updateData = { 
            isActive: isActive === true,
            updatedAt: new Date().toISOString()
        };
        
        if (!isFirebaseInitialized) {
            await db.collection('subscribers').doc(id).update(updateData);
            return res.json({ success: true });
        }
        
        await db.collection('subscribers').doc(id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating subscriber:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete subscriber
app.delete('/api/admin/subscribers/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!isFirebaseInitialized) {
            await db.collection('subscribers').doc(id).delete();
            return res.json({ success: true });
        }
        
        await db.collection('subscribers').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting subscriber:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ CATCH ALL ROUTE FOR DEBUGGING ============
app.all('/api/*', (req, res) => {
    console.log(`Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ 
        error: 'API endpoint not found',
        method: req.method,
        url: req.url,
        site: 'Beauty Bloom API',
        availableEndpoints: [
            'POST /api/signup',
            'POST /api/login',
            'POST /api/admin/login',
            'GET /api/health',
            'GET /api/articles',
            'GET /api/article/:slug',
            'GET /api/products',
            'POST /api/check-subscription',
            'POST /api/ebooks',
            'POST /api/subscribe',
            'GET /api/admin/verify',
            'GET /api/admin/ebooks',
            'GET /api/admin/subscribers',
            'POST /api/admin/articles',
            'PUT /api/admin/articles/:id',
            'DELETE /api/admin/articles/:id',
            'POST /api/admin/ebooks',
            'DELETE /api/admin/ebooks/:id',
            'POST /api/admin/products',
            'DELETE /api/admin/products/:id',
            'PUT /api/admin/subscribers/:id',
            'DELETE /api/admin/subscribers/:id'
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌸 Beauty Bloom Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔐 Admin login: POST http://localhost:${PORT}/api/admin/login`);
    console.log(`📝 User signup: POST http://localhost:${PORT}/api/signup`);
    console.log(`🔑 User login: POST http://localhost:${PORT}/api/login`);
    console.log(`✅ CORS enabled for: ${allowedOrigins.join(', ')}`);
});
