/**
 * LearnedSupersessionModel - P3: Regression Model for Supersession Confidence
 *
 * Inspired by Deep Optimizers from Nested Learning paper.
 * Uses online gradient descent with L2 regularization to learn optimal weights
 * for supersession confidence calculation, replacing fixed weights.
 *
 * Key concepts:
 * - Online learning: Updates weights incrementally as new examples arrive
 * - L2 regularization: Prevents overfitting by penalizing large weights
 * - Logistic regression: Predicts probability of supersession being valid
 */

import {
  SupersessionFeatures,
  SupersessionTrainingExample,
  LearnedModelConfig,
  LearnedWeights,
  INITIAL_WEIGHTS,
  DEFAULT_LEARNED_MODEL_CONFIG,
  ModelTrainingResult,
  SupersessionPrediction,
} from '../../types/sleep-agent.js';

/**
 * LearnedSupersessionModel - Online learning for supersession confidence
 *
 * Uses logistic regression with L2 regularization:
 * - Predicts probability that a supersession candidate is valid
 * - Learns from user feedback (accepted/reverted supersessions)
 * - Falls back to fixed weights when insufficient training data
 */
export class LearnedSupersessionModel {
  private weights: LearnedWeights;
  private trainingExamples: SupersessionTrainingExample[] = [];
  private config: LearnedModelConfig;
  private totalExamplesSeen: number = 0;
  private lastTrainingAt: number = 0;

  constructor(config: Partial<LearnedModelConfig> = {}) {
    this.config = { ...DEFAULT_LEARNED_MODEL_CONFIG, ...config };
    this.weights = { ...INITIAL_WEIGHTS };
  }

  /**
   * Extract features from observation pair for prediction/training
   */
  extractFeatures(
    semanticSimilarity: number,
    topicMatch: boolean,
    fileOverlap: number,
    typeMatch: number,
    timeDeltaHours: number,
    priorityScore: number,
    olderReferenceCount: number
  ): SupersessionFeatures {
    return {
      semanticSimilarity,
      topicMatch,
      fileOverlap,
      typeMatch,
      timeDeltaHours,
      projectMatch: true, // Always true in current implementation
      priorityScore,
      isSuperseded: false, // Will be set by caller if applicable
      olderReferenceCount,
    };
  }

  /**
   * Predict supersession confidence using learned weights
   *
   * Uses sigmoid function: 1 / (1 + exp(-z))
   * where z = w0 + w1*x1 + w2*x2 + ... + wn*xn
   *
   * @param features Feature vector for prediction
   * @returns Prediction with confidence and contribution breakdown
   */
  predict(features: SupersessionFeatures): SupersessionPrediction {
    const shouldUseLearned = this.shouldUseLearnedWeights();
    const weights = shouldUseLearned ? this.weights : INITIAL_WEIGHTS;

    // Normalize timeDeltaHours (log scale, cap at 720 hours = 30 days)
    const normalizedTimeDelta = Math.min(Math.log1p(features.timeDeltaHours), Math.log1p(720)) / Math.log1p(720);

    // Normalize reference count (log scale, cap at 10)
    const normalizedRefCount = Math.min(Math.log1p(features.olderReferenceCount), Math.log1p(10)) / Math.log1p(10);

    // Calculate feature contributions
    const contributions = {
      semanticSimilarity: features.semanticSimilarity * weights.semanticSimilarity,
      topicMatch: (features.topicMatch ? 1 : 0) * weights.topicMatch,
      fileOverlap: features.fileOverlap * weights.fileOverlap,
      typeMatch: features.typeMatch * weights.typeMatch,
      timeDecay: -normalizedTimeDelta * weights.timeDecay, // Negative: older observations get lower score
      priorityBoost: features.priorityScore * weights.priorityBoost,
      referenceDecay: -normalizedRefCount * weights.referenceDecay, // Negative: highly referenced resist supersession
      bias: weights.bias,
    };

    // Sum contributions for raw score (logit)
    const logit =
      contributions.semanticSimilarity +
      contributions.topicMatch +
      contributions.fileOverlap +
      contributions.typeMatch +
      contributions.timeDecay +
      contributions.priorityBoost +
      contributions.referenceDecay +
      contributions.bias;

    // Apply sigmoid to get probability (0-1)
    const confidence = 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, logit)))); // Clamp for numerical stability

    return {
      confidence,
      usingLearnedWeights: shouldUseLearned,
      weights: { ...weights },
      featureContributions: contributions,
    };
  }

  /**
   * Add a training example from user feedback
   *
   * @param features Feature vector
   * @param label True if supersession was accepted, false if rejected/reverted
   * @param confidence Confidence score that was used
   */
  addTrainingExample(features: SupersessionFeatures, label: boolean, confidence: number): void {
    if (!this.config.alwaysCollectData && !this.config.enabled) {
      return;
    }

    const example: SupersessionTrainingExample = {
      features: { ...features },
      label,
      confidence,
      timestamp: Date.now(),
    };

    this.trainingExamples.push(example);
    this.totalExamplesSeen++;

    // Keep only the most recent examples
    if (this.trainingExamples.length > this.config.maxTrainingExamples) {
      this.trainingExamples.shift();
    }
  }

  /**
   * Train the model on collected examples using online gradient descent
   *
   * Uses logistic regression with L2 regularization:
   * - Loss = binary cross-entropy + lambda * ||w||^2
   * - Gradient = (prediction - label) * features + 2 * lambda * weights
   *
   * @returns Training result with updated weights and metrics
   */
  train(): ModelTrainingResult {
    if (this.trainingExamples.length === 0) {
      return {
        examplesUsed: 0,
        weights: { ...this.weights },
        loss: 0,
        accuracy: 0,
        timestamp: Date.now(),
      };
    }

    const learningRate = this.config.learningRate;
    const regularization = this.config.regularization;
    let totalLoss = 0;
    let correct = 0;

    // Run one epoch of gradient descent over all examples
    for (const example of this.trainingExamples) {
      // Get current prediction
      const prediction = this.predict(example.features);
      const predicted = prediction.confidence;

      // Binary cross-entropy loss
      const actual = example.label ? 1 : 0;
      const epsilon = 1e-10;
      const loss =
        -actual * Math.log(predicted + epsilon) -
        (1 - actual) * Math.log(1 - predicted + epsilon);
      totalLoss += loss;

      // Count accuracy
      if ((predicted >= 0.5) === example.label) {
        correct++;
      }

      // Compute gradient: (prediction - label) * features
      const error = predicted - actual;

      // Normalize features for gradient computation
      const normalizedTimeDelta = Math.min(Math.log1p(example.features.timeDeltaHours), Math.log1p(720)) / Math.log1p(720);
      const normalizedRefCount = Math.min(Math.log1p(example.features.olderReferenceCount), Math.log1p(10)) / Math.log1p(10);

      // Update weights using gradient descent with L2 regularization
      // w = w - learning_rate * (gradient + 2 * lambda * w)

      this.weights.semanticSimilarity -= learningRate * (error * example.features.semanticSimilarity + 2 * regularization * this.weights.semanticSimilarity);
      this.weights.topicMatch -= learningRate * (error * (example.features.topicMatch ? 1 : 0) + 2 * regularization * this.weights.topicMatch);
      this.weights.fileOverlap -= learningRate * (error * example.features.fileOverlap + 2 * regularization * this.weights.fileOverlap);
      this.weights.typeMatch -= learningRate * (error * example.features.typeMatch + 2 * regularization * this.weights.typeMatch);
      this.weights.timeDecay -= learningRate * (error * (-normalizedTimeDelta) + 2 * regularization * this.weights.timeDecay);
      this.weights.priorityBoost -= learningRate * (error * example.features.priorityScore + 2 * regularization * this.weights.priorityBoost);
      this.weights.referenceDecay -= learningRate * (error * (-normalizedRefCount) + 2 * regularization * this.weights.referenceDecay);
      this.weights.bias -= learningRate * (error * 1 + 2 * regularization * this.weights.bias);

      // Clip weights to prevent extreme values
      this.clipWeights();
    }

    this.lastTrainingAt = Date.now();

    return {
      examplesUsed: this.trainingExamples.length,
      weights: { ...this.weights },
      loss: totalLoss / this.trainingExamples.length,
      accuracy: correct / this.trainingExamples.length,
      timestamp: this.lastTrainingAt,
    };
  }

  /**
   * Reset weights to initial values
   */
  resetWeights(): void {
    this.weights = { ...INITIAL_WEIGHTS };
    this.trainingExamples = [];
    this.totalExamplesSeen = 0;
    this.lastTrainingAt = 0;
  }

  /**
   * Get current weights
   */
  getWeights(): LearnedWeights {
    return { ...this.weights };
  }

  /**
   * Set weights manually (useful for loading saved models)
   */
  setWeights(weights: LearnedWeights): void {
    this.weights = { ...weights };
  }

  /**
   * Get training statistics
   */
  getTrainingStats(): {
    examplesCollected: number;
    totalExamplesSeen: number;
    lastTrainingAt: number;
    canUseLearnedWeights: boolean;
  } {
    return {
      examplesCollected: this.trainingExamples.length,
      totalExamplesSeen: this.totalExamplesSeen,
      lastTrainingAt: this.lastTrainingAt,
      canUseLearnedWeights: this.shouldUseLearnedWeights(),
    };
  }

  /**
   * Get all training examples (for export/analysis)
   */
  getTrainingExamples(): SupersessionTrainingExample[] {
    return [...this.trainingExamples];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<LearnedModelConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): LearnedModelConfig {
    return { ...this.config };
  }

  /**
   * Determine whether to use learned weights based on configuration and data
   */
  private shouldUseLearnedWeights(): boolean {
    if (!this.config.enabled) {
      return false;
    }
    if (this.trainingExamples.length < this.config.minExamplesBeforeUse) {
      return this.config.fallbackToFixed ? false : true;
    }
    return true;
  }

  /**
   * Clip weights to reasonable range to prevent numerical issues
   */
  private clipWeights(): void {
    const maxWeight = 5.0;
    const minWeight = -5.0;

    this.weights.semanticSimilarity = Math.max(minWeight, Math.min(maxWeight, this.weights.semanticSimilarity));
    this.weights.topicMatch = Math.max(minWeight, Math.min(maxWeight, this.weights.topicMatch));
    this.weights.fileOverlap = Math.max(minWeight, Math.min(maxWeight, this.weights.fileOverlap));
    this.weights.typeMatch = Math.max(minWeight, Math.min(maxWeight, this.weights.typeMatch));
    this.weights.timeDecay = Math.max(minWeight, Math.min(maxWeight, this.weights.timeDecay));
    this.weights.priorityBoost = Math.max(minWeight, Math.min(maxWeight, this.weights.priorityBoost));
    this.weights.referenceDecay = Math.max(minWeight, Math.min(maxWeight, this.weights.referenceDecay));
    this.weights.bias = Math.max(minWeight, Math.min(maxWeight, this.weights.bias));
  }
}
