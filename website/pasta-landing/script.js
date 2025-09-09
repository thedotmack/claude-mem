// Pasta Variable Hunt - Interactive Features
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    initializeNavigation();
    initializeHero();
    initializeMemoryVisualization();
    initializeRecipeTabs();
    initializePastaHunt();
    initializeScrollAnimations();
    addPastaFloatingEffect();
}

// Navigation
function initializeNavigation() {
    const navToggle = document.getElementById('nav-toggle');
    const navLinks = document.querySelector('.nav-links');
    
    if (navToggle) {
        navToggle.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            navToggle.classList.toggle('active');
        });
    }
    
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // Header background on scroll
    window.addEventListener('scroll', () => {
        const header = document.querySelector('.header');
        if (window.scrollY > 100) {
            header.style.background = 'rgba(255, 255, 255, 0.98)';
        } else {
            header.style.background = 'rgba(255, 255, 255, 0.95)';
        }
    });
}

// Hero Section Interactions
function initializeHero() {
    const startHuntBtn = document.getElementById('start-hunt');
    const tasteMemoryBtn = document.getElementById('taste-memory');
    
    if (startHuntBtn) {
        startHuntBtn.addEventListener('click', () => {
            // Scroll to hunt section with fun effect
            const huntSection = document.getElementById('hunt');
            if (huntSection) {
                startHuntBtn.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    startHuntBtn.style.transform = 'scale(1)';
                    huntSection.scrollIntoView({ behavior: 'smooth' });
                }, 100);
            }
        });
    }
    
    if (tasteMemoryBtn) {
        tasteMemoryBtn.addEventListener('click', () => {
            // Show memory compression visualization
            const memoryBowl = document.getElementById('memory-bowl');
            if (memoryBowl) {
                memoryBowl.style.animation = 'none';
                setTimeout(() => {
                    memoryBowl.style.animation = 'float 3s ease-in-out infinite';
                }, 100);
                
                // Add temporary memory bytes
                showMemoryBytes();
            }
        });
    }
}

// Memory Visualization
function initializeMemoryVisualization() {
    const memoryBowl = document.getElementById('memory-bowl');
    
    if (memoryBowl) {
        // Add click interaction
        memoryBowl.addEventListener('click', () => {
            generatePastaBytes();
        });
        
        // Initialize memory bytes
        setInterval(updateMemoryBytes, 3000);
    }
}

function showMemoryBytes() {
    const memoryBytes = document.getElementById('memory-bytes');
    if (memoryBytes) {
        const bytes = ['🧠', '💾', '⚡', '🔥', '✨'];
        let index = 0;
        
        const interval = setInterval(() => {
            memoryBytes.textContent = bytes[index];
            index = (index + 1) % bytes.length;
        }, 500);
        
        setTimeout(() => {
            clearInterval(interval);
            memoryBytes.textContent = '🍝';
        }, 3000);
    }
}

function updateMemoryBytes() {
    const memoryBytes = document.getElementById('memory-bytes');
    if (memoryBytes) {
        const pastaEmojis = ['🍝', '🍜', '🥄', '🧀', '🌿', '🍅'];
        const randomEmoji = pastaEmojis[Math.floor(Math.random() * pastaEmojis.length)];
        memoryBytes.textContent = randomEmoji;
    }
}

function generatePastaBytes() {
    const memoryBowl = document.getElementById('memory-bowl');
    
    // Create floating pasta bytes
    for (let i = 0; i < 5; i++) {
        const byte = document.createElement('div');
        byte.className = 'floating-byte';
        byte.textContent = ['🍝', '🧠', '💾', '⚡'][Math.floor(Math.random() * 4)];
        byte.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 1.5rem;
            pointer-events: none;
            animation: float-away ${2 + Math.random()}s ease-out forwards;
            z-index: 10;
        `;
        
        memoryBowl.appendChild(byte);
        
        setTimeout(() => {
            if (byte.parentNode) {
                byte.parentNode.removeChild(byte);
            }
        }, 3000);
    }
    
    // Add CSS for float-away animation if not exists
    if (!document.querySelector('#float-away-style')) {
        const style = document.createElement('style');
        style.id = 'float-away-style';
        style.textContent = `
            @keyframes float-away {
                0% {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
                100% {
                    opacity: 0;
                    transform: translate(-50%, -150%) scale(0.5);
                }
            }
        `;
        document.head.appendChild(style);
    }
}

// Recipe Tabs
function initializeRecipeTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const recipes = document.querySelectorAll('.recipe');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetRecipe = btn.dataset.recipe;
            
            // Remove active class from all buttons and recipes
            tabBtns.forEach(b => b.classList.remove('active'));
            recipes.forEach(r => r.classList.remove('active'));
            
            // Add active class to clicked button and corresponding recipe
            btn.classList.add('active');
            const targetRecipeElement = document.getElementById(`recipe-${targetRecipe}`);
            if (targetRecipeElement) {
                targetRecipeElement.classList.add('active');
                
                // Animate ingredients in the cooking pot
                animateIngredients(targetRecipe);
            }
        });
    });
    
    // Initialize cooking pot interactions
    initializeCookingPots();
}

function animateIngredients(recipeType) {
    const pot = document.querySelector(`#${recipeType}-pot`);
    if (pot) {
        const ingredients = pot.querySelectorAll('.ingredient');
        ingredients.forEach((ingredient, index) => {
            ingredient.style.animation = 'none';
            setTimeout(() => {
                ingredient.style.animation = `ingredient-bubble 3s infinite ease-in-out ${index * 0.5}s`;
            }, 100);
        });
    }
}

function initializeCookingPots() {
    const ingredients = document.querySelectorAll('.ingredient');
    
    ingredients.forEach(ingredient => {
        ingredient.addEventListener('click', () => {
            // Create cooking effect
            const effect = document.createElement('div');
            effect.textContent = '✨';
            effect.style.cssText = `
                position: absolute;
                top: -20px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 1.5rem;
                animation: cooking-sparkle 1s ease-out forwards;
                pointer-events: none;
            `;
            
            ingredient.style.position = 'relative';
            ingredient.appendChild(effect);
            
            setTimeout(() => {
                if (effect.parentNode) {
                    effect.parentNode.removeChild(effect);
                }
            }, 1000);
        });
    });
    
    // Add cooking sparkle animation
    if (!document.querySelector('#cooking-sparkle-style')) {
        const style = document.createElement('style');
        style.id = 'cooking-sparkle-style';
        style.textContent = `
            @keyframes cooking-sparkle {
                0% {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0) scale(1);
                }
                100% {
                    opacity: 0;
                    transform: translateX(-50%) translateY(-30px) scale(1.5);
                }
            }
        `;
        document.head.appendChild(style);
    }
}

// Pasta Hunt Game
function initializePastaHunt() {
    const huntVariables = document.querySelectorAll('.variable-hunt');
    const foundCountEl = document.getElementById('found-count');
    const totalCountEl = document.getElementById('total-count');
    const scoreEl = document.getElementById('score');
    const messageEl = document.getElementById('hunt-message');
    
    let foundCount = 0;
    let score = 0;
    const totalCount = huntVariables.length;
    
    if (totalCountEl) {
        totalCountEl.textContent = totalCount;
    }
    
    huntVariables.forEach(variable => {
        variable.addEventListener('click', () => {
            if (!variable.classList.contains('found')) {
                variable.classList.add('found');
                foundCount++;
                score += 10;
                
                // Update stats
                if (foundCountEl) foundCountEl.textContent = foundCount;
                if (scoreEl) scoreEl.textContent = score;
                
                // Show pasta emoji effect
                showPastaEffect(variable);
                
                // Update message
                if (messageEl) {
                    const pastaName = variable.dataset.pasta;
                    messageEl.textContent = `Great! You found ${pastaName}! 🍝`;
                    
                    if (foundCount === totalCount) {
                        setTimeout(() => {
                            messageEl.textContent = `Bravissimo! You found all the pasta variables! 🎉🍝`;
                            showVictoryAnimation();
                        }, 1000);
                    } else {
                        setTimeout(() => {
                            messageEl.textContent = `${totalCount - foundCount} more pasta variables to find! 🔍`;
                        }, 2000);
                    }
                }
            }
        });
    });
}

function showPastaEffect(element) {
    const rect = element.getBoundingClientRect();
    const effect = document.createElement('div');
    effect.textContent = '🍝';
    effect.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left + rect.width / 2}px;
        transform: translateX(-50%);
        font-size: 2rem;
        animation: pasta-found 1s ease-out forwards;
        pointer-events: none;
        z-index: 1000;
    `;
    
    document.body.appendChild(effect);
    
    setTimeout(() => {
        if (effect.parentNode) {
            effect.parentNode.removeChild(effect);
        }
    }, 1000);
    
    // Add pasta found animation
    if (!document.querySelector('#pasta-found-style')) {
        const style = document.createElement('style');
        style.id = 'pasta-found-style';
        style.textContent = `
            @keyframes pasta-found {
                0% {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0) scale(1);
                }
                50% {
                    transform: translateX(-50%) translateY(-20px) scale(1.5);
                }
                100% {
                    opacity: 0;
                    transform: translateX(-50%) translateY(-40px) scale(0.5);
                }
            }
        `;
        document.head.appendChild(style);
    }
}

function showVictoryAnimation() {
    // Create pasta rain effect
    for (let i = 0; i < 20; i++) {
        setTimeout(() => {
            createFallingPasta();
        }, i * 100);
    }
}

function createFallingPasta() {
    const pasta = document.createElement('div');
    const pastaTypes = ['🍝', '🍜', '🥟', '🧀', '🌿', '🍅'];
    pasta.textContent = pastaTypes[Math.floor(Math.random() * pastaTypes.length)];
    pasta.style.cssText = `
        position: fixed;
        top: -50px;
        left: ${Math.random() * window.innerWidth}px;
        font-size: 2rem;
        animation: pasta-fall 3s linear forwards;
        pointer-events: none;
        z-index: 1000;
    `;
    
    document.body.appendChild(pasta);
    
    setTimeout(() => {
        if (pasta.parentNode) {
            pasta.parentNode.removeChild(pasta);
        }
    }, 3000);
    
    // Add pasta fall animation
    if (!document.querySelector('#pasta-fall-style')) {
        const style = document.createElement('style');
        style.id = 'pasta-fall-style';
        style.textContent = `
            @keyframes pasta-fall {
                0% {
                    transform: translateY(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(${window.innerHeight + 100}px) rotate(360deg);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }
}

// Scroll Animations
function initializeScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.animation = 'fade-in-up 0.8s ease-out forwards';
                entry.target.style.opacity = '1';
            }
        });
    }, observerOptions);
    
    // Observe story cards
    document.querySelectorAll('.story-card').forEach(card => {
        card.style.opacity = '0';
        observer.observe(card);
    });
    
    // Observe recipe sections
    document.querySelectorAll('.recipe').forEach(recipe => {
        observer.observe(recipe);
    });
}

// Floating Pasta Background Effect
function addPastaFloatingEffect() {
    const pastaBackground = document.getElementById('pasta-bg');
    if (!pastaBackground) return;
    
    // Create floating pasta elements
    for (let i = 0; i < 15; i++) {
        const pastaElement = document.createElement('div');
        const pastaTypes = ['🍝', '🍜', '🥟'];
        pastaElement.textContent = pastaTypes[Math.floor(Math.random() * pastaTypes.length)];
        pastaElement.style.cssText = `
            position: absolute;
            top: ${Math.random() * 100}%;
            left: ${Math.random() * 100}%;
            font-size: ${1 + Math.random() * 2}rem;
            opacity: 0.1;
            animation: pasta-float-bg ${10 + Math.random() * 10}s infinite linear;
            pointer-events: none;
        `;
        pastaBackground.appendChild(pastaElement);
    }
    
    // Add floating background animation
    if (!document.querySelector('#pasta-float-bg-style')) {
        const style = document.createElement('style');
        style.id = 'pasta-float-bg-style';
        style.textContent = `
            @keyframes pasta-float-bg {
                0% {
                    transform: translateY(100vh) rotate(0deg);
                }
                100% {
                    transform: translateY(-100px) rotate(360deg);
                }
            }
        `;
        document.head.appendChild(style);
    }
}

// Lasagna Layer Interactions
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('layer')) {
        const layer = e.target;
        const layerType = layer.dataset.layer;
        
        // Show layer information
        showLayerInfo(layerType, layer);
    }
});

function showLayerInfo(layerType, element) {
    const info = {
        'embedding-1': 'This layer captures the contextual meaning of your conversations',
        'embedding-2': 'This layer identifies semantic relationships between concepts',
        'embedding-3': 'This layer creates cross-references to related memories',
        'embedding-4': 'This layer stores the compressed memory for quick retrieval'
    };
    
    const tooltip = document.createElement('div');
    tooltip.textContent = info[layerType] || 'A delicious layer of memory compression!';
    tooltip.style.cssText = `
        position: absolute;
        top: -60px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 1rem;
        border-radius: 10px;
        font-size: 0.9rem;
        white-space: nowrap;
        z-index: 100;
        animation: tooltip-appear 0.3s ease-out;
    `;
    
    element.style.position = 'relative';
    element.appendChild(tooltip);
    
    setTimeout(() => {
        if (tooltip.parentNode) {
            tooltip.parentNode.removeChild(tooltip);
        }
    }, 3000);
}

// Add some fun console messages for developers
console.log(`
🍝 Welcome to the Pasta Variable Hunt! 🍝

This landing page demonstrates how memory compression 
can be as artful as Italian cuisine. 

Try these fun interactions:
- Click the memory bowl in the hero section
- Hunt for pasta variables in the code
- Hover over the lasagna layers
- Click ingredients in the cooking pots

Buon appetito! 🧠✨
`);

// Easter egg: Konami code for extra pasta
let konamiCode = [];
const konamiSequence = [
    'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 
    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 
    'KeyB', 'KeyA'
];

document.addEventListener('keydown', function(e) {
    konamiCode.push(e.code);
    if (konamiCode.length > konamiSequence.length) {
        konamiCode.shift();
    }
    
    if (konamiCode.join(',') === konamiSequence.join(',')) {
        // Activate pasta mode!
        activatePastaMode();
        konamiCode = [];
    }
});

function activatePastaMode() {
    console.log('🍝 PASTA MODE ACTIVATED! 🍝');
    
    // Make everything more pasta-y
    document.body.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3Ctext y=\'50%25\' font-size=\'20\'%3E🍝%3C/text%3E%3C/svg%3E"), auto';
    
    // Add pasta explosion
    for (let i = 0; i < 50; i++) {
        setTimeout(() => {
            createFallingPasta();
        }, i * 50);
    }
    
    // Show secret message
    const message = document.createElement('div');
    message.textContent = '🍝 PASTA MODE ACTIVATED! 🍝';
    message.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(206, 43, 55, 0.95);
        color: white;
        padding: 2rem 4rem;
        border-radius: 20px;
        font-size: 2rem;
        font-weight: bold;
        z-index: 10000;
        animation: pasta-mode-announce 3s ease-out forwards;
    `;
    
    document.body.appendChild(message);
    
    setTimeout(() => {
        if (message.parentNode) {
            message.parentNode.removeChild(message);
        }
        document.body.style.cursor = 'auto';
    }, 3000);
}