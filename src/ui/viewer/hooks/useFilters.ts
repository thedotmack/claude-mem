import { useState, useCallback, useMemo } from 'react';
import type { FilterState } from '../types';

const EMPTY_FILTER: FilterState = {
  query: '',
  project: '',
  obsTypes: [],
  concepts: [],
  itemKinds: [],
  dateStart: '',
  dateEnd: '',
};

export function useFilters() {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTER);

  const setQuery = useCallback((query: string) => {
    setFilters(prev => ({ ...prev, query }));
  }, []);

  const setProject = useCallback((project: string) => {
    setFilters(prev => ({ ...prev, project }));
  }, []);

  const toggleObsType = useCallback((type: string) => {
    setFilters(prev => ({
      ...prev,
      obsTypes: prev.obsTypes.includes(type)
        ? prev.obsTypes.filter(t => t !== type)
        : [...prev.obsTypes, type]
    }));
  }, []);

  const toggleConcept = useCallback((concept: string) => {
    setFilters(prev => ({
      ...prev,
      concepts: prev.concepts.includes(concept)
        ? prev.concepts.filter(c => c !== concept)
        : [...prev.concepts, concept]
    }));
  }, []);

  const toggleItemKind = useCallback((kind: 'observations' | 'sessions' | 'prompts') => {
    setFilters(prev => ({
      ...prev,
      // Single-select: clicking the active kind deselects it, otherwise replaces
      itemKinds: prev.itemKinds.includes(kind) ? [] : [kind]
    }));
  }, []);

  const setDateRange = useCallback((dateStart: string, dateEnd: string) => {
    setFilters(prev => ({ ...prev, dateStart, dateEnd }));
  }, []);

  const clearAll = useCallback(() => {
    setFilters(EMPTY_FILTER);
  }, []);

  const hasActiveFilters = useMemo(() => {
    return filters.query !== '' ||
      filters.project !== '' ||
      filters.obsTypes.length > 0 ||
      filters.concepts.length > 0 ||
      filters.itemKinds.length > 0 ||
      filters.dateStart !== '' ||
      filters.dateEnd !== '';
  }, [filters]);

  const isFilterMode = useMemo(() => {
    return filters.query !== '' ||
      filters.obsTypes.length > 0 ||
      filters.concepts.length > 0 ||
      filters.itemKinds.length > 0 ||
      filters.dateStart !== '' ||
      filters.dateEnd !== '';
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.query) count++;
    if (filters.obsTypes.length > 0) count++;
    if (filters.concepts.length > 0) count++;
    if (filters.itemKinds.length > 0) count++;
    if (filters.dateStart || filters.dateEnd) count++;
    return count;
  }, [filters]);

  return {
    filters,
    setQuery,
    setProject,
    toggleObsType,
    toggleConcept,
    toggleItemKind,
    setDateRange,
    clearAll,
    hasActiveFilters,
    isFilterMode,
    activeFilterCount,
  };
}
