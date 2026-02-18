"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Compliance reporting for Caracal Enterprise.

This module provides compliance reporting capabilities for Caracal Enterprise.
In the open source edition, all compliance methods are stubbed and raise
EnterpriseFeatureRequired exceptions.

Note: Basic audit log export is available in the open source edition via
the CLI command: caracal audit export

Enterprise Compliance Features:
- SOC 2 compliance reports
- ISO 27001 compliance reports
- GDPR compliance reports
- HIPAA compliance reports
- Custom audit reports
- Automated compliance checks
- Compliance dashboard
"""

from abc import ABC, abstractmethod
from typing import Any, Optional

from caracal.enterprise.exceptions import EnterpriseFeatureRequired


class ComplianceReporter(ABC):
    """
    Abstract base class for compliance reporting.
    
    ENTERPRISE ONLY: Compliance reports require Caracal Enterprise.
    
    Compliance reporters generate formatted compliance reports based on
    authority ledger data, demonstrating adherence to various compliance
    frameworks and regulations.
    
    In Caracal Enterprise, implementations would:
    - Generate SOC 2 Type II reports
    - Generate ISO 27001 audit reports
    - Generate GDPR data access reports
    - Generate HIPAA audit trails
    - Provide automated compliance checks
    - Export reports in multiple formats
    """
    
    @abstractmethod
    def generate_soc2_report(
        self,
        time_range: tuple[str, str],
        report_type: str = "type2",
    ) -> bytes:
        """
        Generate SOC 2 compliance report.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
            report_type: Report type ("type1" or "type2")
        
        Returns:
            PDF report as bytes
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise SOC 2 Report Sections:
            - Control environment
            - Risk assessment
            - Control activities
            - Information and communication
            - Monitoring activities
            - Trust services criteria (security, availability, confidentiality)
            - Authority enforcement controls
            - Audit trail evidence
        """
        pass
    
    @abstractmethod
    def generate_iso27001_report(
        self,
        time_range: tuple[str, str],
        annexes: Optional[list[str]] = None,
    ) -> bytes:
        """
        Generate ISO 27001 compliance report.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
            annexes: Optional list of Annex A controls to include
        
        Returns:
            PDF report as bytes
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise ISO 27001 Report Sections:
            - Information security policies
            - Organization of information security
            - Human resource security
            - Asset management
            - Access control (authority enforcement)
            - Cryptography
            - Operations security
            - Communications security
            - System acquisition, development and maintenance
            - Supplier relationships
            - Information security incident management
            - Business continuity management
            - Compliance
        """
        pass
    
    @abstractmethod
    def generate_gdpr_report(
        self,
        time_range: tuple[str, str],
        data_subject_id: Optional[str] = None,
    ) -> bytes:
        """
        Generate GDPR compliance report.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
            data_subject_id: Optional data subject (principal) ID
        
        Returns:
            PDF report as bytes
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise GDPR Report Sections:
            - Data processing activities
            - Legal basis for processing
            - Data subject rights (access, rectification, erasure)
            - Data protection by design and default
            - Security of processing
            - Data breach notifications
            - Data protection impact assessments
            - Records of processing activities
        """
        pass
    
    @abstractmethod
    def generate_hipaa_report(
        self,
        time_range: tuple[str, str],
    ) -> bytes:
        """
        Generate HIPAA compliance report.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
        
        Returns:
            PDF report as bytes
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise HIPAA Report Sections:
            - Administrative safeguards
            - Physical safeguards
            - Technical safeguards (authority enforcement)
            - Access controls
            - Audit controls
            - Integrity controls
            - Transmission security
            - Breach notification
        """
        pass
    
    @abstractmethod
    def generate_audit_report(
        self,
        time_range: tuple[str, str],
        format: str = "pdf",
        filters: Optional[dict[str, Any]] = None,
    ) -> bytes:
        """
        Generate custom audit report.
        
        Args:
            time_range: Tuple of (start_time, end_time) in ISO format
            format: Report format (pdf, csv, excel, json)
            filters: Optional filters for audit data
        
        Returns:
            Report data in requested format
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Audit Report Sections:
            - Executive summary
            - Mandate issuance activity
            - Validation activity
            - Denial analysis
            - Revocation activity
            - Delegation chains
            - Principal activity
            - Resource access patterns
            - Security incidents
            - Recommendations
        """
        pass
    
    @abstractmethod
    def run_compliance_check(
        self,
        framework: str,
    ) -> dict[str, Any]:
        """
        Run automated compliance check.
        
        Args:
            framework: Compliance framework (soc2, iso27001, gdpr, hipaa)
        
        Returns:
            Dictionary with compliance check results
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Compliance Check Results:
            - compliant: Overall compliance status
            - controls_passed: Number of controls passed
            - controls_failed: Number of controls failed
            - findings: List of compliance findings
            - recommendations: Remediation recommendations
            - risk_level: Overall risk level
        """
        pass


class OpenSourceComplianceReporter(ComplianceReporter):
    """
    Open source compliance stub.
    
    Compliance reporting requires Caracal Enterprise.
    Basic audit log export is available via CLI: caracal audit export
    
    Usage:
        >>> compliance = OpenSourceComplianceReporter()
        >>> try:
        ...     report = compliance.generate_soc2_report(time_range)
        ... except EnterpriseFeatureRequired as e:
        ...     print(e.message)
    """
    
    def generate_soc2_report(
        self,
        time_range: tuple[str, str],
        report_type: str = "type2",
    ) -> bytes:
        """
        Generate SOC 2 compliance report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        Basic audit log export is available via: caracal audit export
        
        Args:
            time_range: Time range (ignored in open source)
            report_type: Report type (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="SOC 2 Compliance Report",
            message=(
                "SOC 2 compliance reporting requires Caracal Enterprise. "
                "Basic audit log export is available via: caracal audit export"
            ),
        )
    
    def generate_iso27001_report(
        self,
        time_range: tuple[str, str],
        annexes: Optional[list[str]] = None,
    ) -> bytes:
        """
        Generate ISO 27001 compliance report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            time_range: Time range (ignored in open source)
            annexes: Annexes (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="ISO 27001 Compliance Report",
            message=(
                "ISO 27001 compliance reporting requires Caracal Enterprise. "
                "Basic audit log export is available via: caracal audit export"
            ),
        )
    
    def generate_gdpr_report(
        self,
        time_range: tuple[str, str],
        data_subject_id: Optional[str] = None,
    ) -> bytes:
        """
        Generate GDPR compliance report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            time_range: Time range (ignored in open source)
            data_subject_id: Data subject ID (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="GDPR Compliance Report",
            message=(
                "GDPR compliance reporting requires Caracal Enterprise. "
                "Basic audit log export is available via: caracal audit export"
            ),
        )
    
    def generate_hipaa_report(
        self,
        time_range: tuple[str, str],
    ) -> bytes:
        """
        Generate HIPAA compliance report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            time_range: Time range (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="HIPAA Compliance Report",
            message=(
                "HIPAA compliance reporting requires Caracal Enterprise. "
                "Basic audit log export is available via: caracal audit export"
            ),
        )
    
    def generate_audit_report(
        self,
        time_range: tuple[str, str],
        format: str = "pdf",
        filters: Optional[dict[str, Any]] = None,
    ) -> bytes:
        """
        Generate custom audit report.
        
        In open source, this always raises EnterpriseFeatureRequired.
        Basic audit log export is available via: caracal audit export
        
        Args:
            time_range: Time range (ignored in open source)
            format: Format (ignored in open source)
            filters: Filters (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Audit Report Generation",
            message=(
                "Formatted audit reports require Caracal Enterprise. "
                "Basic audit log export is available via: caracal audit export"
            ),
        )
    
    def run_compliance_check(
        self,
        framework: str,
    ) -> dict[str, Any]:
        """
        Run automated compliance check.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            framework: Framework (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="Automated Compliance Checks",
            message=(
                "Automated compliance checks require Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )


# Convenience function for getting compliance reporter
def get_compliance_reporter() -> ComplianceReporter:
    """
    Get compliance reporter instance.
    
    In open source, always returns OpenSourceComplianceReporter.
    In Caracal Enterprise, returns the full compliance reporter.
    
    Returns:
        ComplianceReporter instance (OpenSourceComplianceReporter in open source)
    """
    # In open source, always return the stub
    return OpenSourceComplianceReporter()
