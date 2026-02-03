"""
Time window calculation for Caracal Core v0.3.

This module provides the TimeWindowCalculator for calculating time window bounds
for budget policies with support for:
- Hourly, daily, weekly, monthly time windows
- Rolling windows (sliding time periods)
- Calendar windows (aligned to calendar boundaries)

Requirements: 9.1, 9.2, 9.3, 9.4, 9.7, 10.2, 10.3, 10.4, 10.5, 10.6
"""

from datetime import datetime, timedelta
from typing import Tuple

from caracal.exceptions import InvalidPolicyError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class TimeWindowCalculator:
    """
    Calculate time window bounds for budget policies.
    
    Supports:
    - Time windows: hourly, daily, weekly, monthly
    - Window types: rolling (sliding), calendar (aligned to boundaries)
    
    Rolling windows slide continuously (e.g., last 24 hours from now).
    Calendar windows align to calendar boundaries (e.g., start of current day).
    """
    
    def calculate_window_bounds(
        self,
        time_window: str,
        window_type: str,
        reference_time: datetime = None
    ) -> Tuple[datetime, datetime]:
        """
        Calculate window bounds based on time_window and window_type.
        
        Args:
            time_window: Time window type ("hourly", "daily", "weekly", "monthly")
            window_type: Window calculation type ("rolling" or "calendar")
            reference_time: Reference time for calculation (defaults to UTC now)
            
        Returns:
            Tuple of (start_time, end_time) for the window
            
        Raises:
            InvalidPolicyError: If time_window or window_type is invalid
            
        Requirements: 9.1, 9.2, 9.3, 9.4, 9.7, 10.1
        """
        # Use current UTC time if not provided
        if reference_time is None:
            reference_time = datetime.utcnow()
        
        # Validate time_window
        valid_time_windows = ['hourly', 'daily', 'weekly', 'monthly']
        if time_window not in valid_time_windows:
            raise InvalidPolicyError(
                f"Invalid time window '{time_window}'. Must be one of: {valid_time_windows}"
            )
        
        # Validate window_type
        valid_window_types = ['rolling', 'calendar']
        if window_type not in valid_window_types:
            raise InvalidPolicyError(
                f"Invalid window type '{window_type}'. Must be one of: {valid_window_types}"
            )
        
        # Calculate bounds based on window type
        if window_type == 'rolling':
            start_time, end_time = self.calculate_rolling_window(time_window, reference_time)
        else:  # calendar
            start_time, end_time = self.calculate_calendar_window(time_window, reference_time)
        
        logger.debug(
            f"Calculated {window_type} {time_window} window: "
            f"{start_time.isoformat()} to {end_time.isoformat()}"
        )
        
        return start_time, end_time
    
    def calculate_rolling_window(
        self,
        time_window: str,
        reference_time: datetime
    ) -> Tuple[datetime, datetime]:
        """
        Calculate rolling window bounds (sliding time period).
        
        Rolling windows slide continuously from the reference time:
        - hourly: (reference_time - 1 hour, reference_time)
        - daily: (reference_time - 1 day, reference_time)
        - weekly: (reference_time - 7 days, reference_time)
        - monthly: (reference_time - 30 days, reference_time)
        
        Args:
            time_window: Time window type ("hourly", "daily", "weekly", "monthly")
            reference_time: Reference time for calculation
            
        Returns:
            Tuple of (start_time, end_time) for the rolling window
            
        Requirements: 9.5, 10.2
        """
        end_time = reference_time
        
        if time_window == 'hourly':
            # Last 1 hour
            start_time = reference_time - timedelta(hours=1)
        elif time_window == 'daily':
            # Last 24 hours
            start_time = reference_time - timedelta(days=1)
        elif time_window == 'weekly':
            # Last 7 days
            start_time = reference_time - timedelta(days=7)
        elif time_window == 'monthly':
            # Last 30 days (approximation)
            start_time = reference_time - timedelta(days=30)
        else:
            raise InvalidPolicyError(f"Invalid time window '{time_window}'")
        
        return start_time, end_time
    
    def calculate_calendar_window(
        self,
        time_window: str,
        reference_time: datetime
    ) -> Tuple[datetime, datetime]:
        """
        Calculate calendar window bounds (aligned to calendar boundaries).
        
        Calendar windows align to calendar boundaries:
        - hourly: (start of current hour, reference_time)
        - daily: (start of current day, reference_time)
        - weekly: (start of current week Monday, reference_time)
        - monthly: (start of current month, reference_time)
        
        Args:
            time_window: Time window type ("hourly", "daily", "weekly", "monthly")
            reference_time: Reference time for calculation
            
        Returns:
            Tuple of (start_time, end_time) for the calendar window
            
        Requirements: 9.6, 10.3, 10.4, 10.5, 10.6
        """
        end_time = reference_time
        
        if time_window == 'hourly':
            # Start of current hour (00 minutes, 00 seconds)
            start_time = reference_time.replace(minute=0, second=0, microsecond=0)
        elif time_window == 'daily':
            # Start of current day (00:00:00)
            start_time = reference_time.replace(hour=0, minute=0, second=0, microsecond=0)
        elif time_window == 'weekly':
            # Start of current week (Monday 00:00:00)
            # weekday() returns 0 for Monday, 6 for Sunday
            days_since_monday = reference_time.weekday()
            start_of_week = reference_time - timedelta(days=days_since_monday)
            start_time = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
        elif time_window == 'monthly':
            # Start of current month (1st day 00:00:00)
            start_time = reference_time.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            raise InvalidPolicyError(f"Invalid time window '{time_window}'")
        
        return start_time, end_time
