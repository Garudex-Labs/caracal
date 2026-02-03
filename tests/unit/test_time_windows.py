"""
Unit tests for TimeWindowCalculator.

Tests time window calculation for hourly, daily, weekly, monthly windows
with both rolling and calendar window types.
"""

import pytest
from datetime import datetime, timedelta
from caracal.core.time_windows import TimeWindowCalculator
from caracal.exceptions import InvalidPolicyError


class TestTimeWindowCalculator:
    """Test suite for TimeWindowCalculator."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.calculator = TimeWindowCalculator()
        # Use a fixed reference time for consistent testing
        self.reference_time = datetime(2024, 1, 15, 14, 30, 45)  # Monday, Jan 15, 2024, 14:30:45
    
    def test_rolling_hourly_window(self):
        """Test rolling hourly window calculation."""
        start, end = self.calculator.calculate_rolling_window('hourly', self.reference_time)
        
        expected_start = self.reference_time - timedelta(hours=1)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_rolling_daily_window(self):
        """Test rolling daily window calculation."""
        start, end = self.calculator.calculate_rolling_window('daily', self.reference_time)
        
        expected_start = self.reference_time - timedelta(days=1)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_rolling_weekly_window(self):
        """Test rolling weekly window calculation."""
        start, end = self.calculator.calculate_rolling_window('weekly', self.reference_time)
        
        expected_start = self.reference_time - timedelta(days=7)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_rolling_monthly_window(self):
        """Test rolling monthly window calculation."""
        start, end = self.calculator.calculate_rolling_window('monthly', self.reference_time)
        
        expected_start = self.reference_time - timedelta(days=30)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calendar_hourly_window(self):
        """Test calendar hourly window calculation."""
        start, end = self.calculator.calculate_calendar_window('hourly', self.reference_time)
        
        # Start of current hour (14:00:00)
        expected_start = datetime(2024, 1, 15, 14, 0, 0)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calendar_daily_window(self):
        """Test calendar daily window calculation."""
        start, end = self.calculator.calculate_calendar_window('daily', self.reference_time)
        
        # Start of current day (00:00:00)
        expected_start = datetime(2024, 1, 15, 0, 0, 0)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calendar_weekly_window(self):
        """Test calendar weekly window calculation."""
        start, end = self.calculator.calculate_calendar_window('weekly', self.reference_time)
        
        # Start of current week (Monday 00:00:00)
        # Jan 15, 2024 is a Monday, so start should be same day
        expected_start = datetime(2024, 1, 15, 0, 0, 0)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calendar_weekly_window_mid_week(self):
        """Test calendar weekly window calculation for mid-week date."""
        # Wednesday, Jan 17, 2024
        mid_week_time = datetime(2024, 1, 17, 14, 30, 45)
        start, end = self.calculator.calculate_calendar_window('weekly', mid_week_time)
        
        # Start of current week (Monday Jan 15, 00:00:00)
        expected_start = datetime(2024, 1, 15, 0, 0, 0)
        expected_end = mid_week_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calendar_monthly_window(self):
        """Test calendar monthly window calculation."""
        start, end = self.calculator.calculate_calendar_window('monthly', self.reference_time)
        
        # Start of current month (Jan 1, 00:00:00)
        expected_start = datetime(2024, 1, 1, 0, 0, 0)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calculate_window_bounds_rolling(self):
        """Test calculate_window_bounds with rolling window type."""
        start, end = self.calculator.calculate_window_bounds(
            'daily', 'rolling', self.reference_time
        )
        
        expected_start = self.reference_time - timedelta(days=1)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calculate_window_bounds_calendar(self):
        """Test calculate_window_bounds with calendar window type."""
        start, end = self.calculator.calculate_window_bounds(
            'daily', 'calendar', self.reference_time
        )
        
        expected_start = datetime(2024, 1, 15, 0, 0, 0)
        expected_end = self.reference_time
        
        assert start == expected_start
        assert end == expected_end
    
    def test_calculate_window_bounds_default_reference_time(self):
        """Test calculate_window_bounds with default reference time (now)."""
        # Should not raise an error
        start, end = self.calculator.calculate_window_bounds('daily', 'calendar')
        
        # Verify start is before end
        assert start < end
        
        # Verify end is close to now (within 1 second)
        now = datetime.utcnow()
        assert abs((end - now).total_seconds()) < 1
    
    def test_invalid_time_window(self):
        """Test that invalid time window raises error."""
        with pytest.raises(InvalidPolicyError) as exc_info:
            self.calculator.calculate_window_bounds('invalid', 'calendar', self.reference_time)
        
        assert "Invalid time window 'invalid'" in str(exc_info.value)
    
    def test_invalid_window_type(self):
        """Test that invalid window type raises error."""
        with pytest.raises(InvalidPolicyError) as exc_info:
            self.calculator.calculate_window_bounds('daily', 'invalid', self.reference_time)
        
        assert "Invalid window type 'invalid'" in str(exc_info.value)
    
    def test_all_time_windows_supported(self):
        """Test that all time windows are supported."""
        time_windows = ['hourly', 'daily', 'weekly', 'monthly']
        window_types = ['rolling', 'calendar']
        
        for time_window in time_windows:
            for window_type in window_types:
                # Should not raise an error
                start, end = self.calculator.calculate_window_bounds(
                    time_window, window_type, self.reference_time
                )
                
                # Verify start is before end
                assert start < end
                
                # Verify end equals reference time
                assert end == self.reference_time
